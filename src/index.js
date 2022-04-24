/**
 * ssh2 sftp client for node
 */

'use strict';

const { Client } = require('ssh2');
const fs = require('fs');
const concat = require('concat-stream');
const promiseRetry = require('promise-retry');
const { join, parse } = require('path');
const {
  fmtError,
  addTempListeners,
  removeTempListeners,
  haveConnection,
  normalizeRemotePath,
  localExists,
  haveLocalAccess,
  haveLocalCreate,
  sleep,
} = require('./utils');
const { errorCode } = require('./constants');

class SftpClient {
  constructor(clientName) {
    this.client = new Client();
    this.sftp = undefined;
    this.clientName = clientName ? clientName : 'sftp';
    this.endCalled = false;
    this.errorHandled = false;
    this.closeHandled = false;
    this.endHandled = false;
    this.remotePathSep = '/';
    this.remotePlatform = 'unix';
    this.debug = undefined;

    this.client.on('close', () => {
      if (this.endCalled || this.closeHandled) {
        // we are processing an expected end event or close event handled elsewhere
        this.debugMsg('Global: Ignoring handled close event');
      } else {
        this.debugMsg('Global: Handling unexpected close event');
        this.sftp = undefined;
      }
    });

    this.client.on('end', () => {
      if (this.endCalled || this.endHandled) {
        // end event expected or handled elsewhere
        this.debugMsg('Global: Ignoring hanlded end event');
      } else {
        this.debugMsg('Global: Handling unexpected end event');
        this.sftp = undefined;
      }
    });

    this.client.on('error', (err) => {
      if (this.endCalled || this.errorHandled) {
        // error event expected or handled elsewhere
        this.debugMsg(`Global: Ignoring handled error: ${err.message}`);
      } else {
        this.debugMsg(`Global; Handling unexpected error; ${err.message}`);
        this.sftp = undefined;
        console.log(
          `ssh2-sftp-client: Unexpected error: ${err.message}. Error code: ${err.code}`
        );
      }
    });
  }

  debugMsg(msg, obj) {
    if (this.debug) {
      if (obj) {
        this.debug(`CLIENT[${this.clientName}]: ${msg} ${JSON.stringify(obj, null, ' ')}`);
      } else {
        this.debug(`CLIENT[${this.clientName}]: ${msg}`);
      }
    }
  }

  /**
   * Add a listner to the client object. This is rarely necessary and can be
   * the source of errors. It is the client's responsibility to remove the
   * listeners when no longer required. Failure to do so can result in memory
   * leaks.
   *
   * @param {string} eventType - one of the supported event types
   * @param {function} callback - function called when event triggers
   */
  on(eventType, callback) {
    this.debugMsg(`Adding listener to ${eventType} event`);
    this.client.prependListener(eventType, callback);
  }

  removeListener(eventType, callback) {
    this.debugMsg(`Removing listener from ${eventType} event`);
    this.client.removeListener(eventType, callback);
  }

  _resetEventFlags() {
    this.closeHandled = false;
    this.endHandled = false;
    this.errorHandled = false;
  }

  /**
   * @async
   *
   * Create a new SFTP connection to a remote SFTP server
   *
   * @param {Object} config - an SFTP configuration object
   *
   * @return {Promise<Object>} which will resolve to an sftp client object
   *
   */
  getConnection(config) {
    let doReady, listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'getConnection', reject);
      this.debugMsg('getConnection: created promise');
      doReady = () => {
        this.debugMsg('getConnection ready listener: got connection - promise resolved');
        resolve(true);
      };
      this.on('ready', doReady);
      this.client.connect(config);
    }).finally(async () => {
      this.debugMsg('getConnection: finally clause fired');
      await sleep(500);
      this.removeListener('ready', doReady);
      removeTempListeners(this, listeners, 'getConnection');
      this._resetEventFlags();
    });
  }

  getSftpChannel() {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'getSftpChannel', reject);
      this.debugMsg('getSftpChannel: created promise');
      this.client.sftp((err, sftp) => {
        if (err) {
          this.debugMsg(`getSftpChannel: SFTP Channel Error: ${err.message}`);
          this.client.end();
          reject(fmtError(err, 'getSftpChannel', err.code));
        } else {
          this.debugMsg('getSftpChannel: SFTP channel established');
          this.sftp = sftp;
          resolve(sftp);
        }
      });
    }).finally(() => {
      this.debugMsg('getSftpChannel: finally clause fired');
      removeTempListeners(this, listeners, 'getSftpChannel');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Create a new SFTP connection to a remote SFTP server.
   * The connection options are the same as those offered
   * by the underlying SSH2 module.
   *
   * @param {Object} config - an SFTP configuration object
   *
   * @return {Promise<Object>} which will resolve to an sftp client object
   *
   */
  async connect(config) {
    try {
      if (config.debug) {
        this.debug = config.debug;
        this.debugMsg('connect: Debugging turned on');
      }
      if (this.sftp) {
        this.debugMsg('connect: Already connected - reject');
        throw fmtError(
          'An existing SFTP connection is already defined',
          'connect',
          errorCode.connect
        );
      }
      await promiseRetry(
        (retry, attempt) => {
          this.debugMsg(`connect: Connect attempt ${attempt}`);
          return this.getConnection(config).catch((err) => {
            this.debugMsg(`getConnection retry catch: ${err.message} Code: ${err.code}`);
            switch (err.code) {
              case 'ENOTFOUND':
              case 'ECONNREFUSED':
              case 'ERR_SOCKET_BAD_PORT':
                throw err;
              default:
                retry(err);
            }
          });
        },
        {
          retries: config.retries || 1,
          factor: config.retry_factor || 2,
          minTimeout: config.retry_minTimeout || 1000,
        }
      );
      return this.getSftpChannel();
    } catch (err) {
      this.debugMsg(`connect: Error ${err.message}`);
      this._resetEventFlags();
      throw fmtError(err, 'connect');
    }
  }

  /**
   * @async
   *
   * Returns the real absolute path on the remote server. Is able to handle
   * both '.' and '..' in path names, but not '~'. If the path is relative
   * then the current working directory is prepended to create an absolute path.
   * Returns undefined if the path does not exists.
   *
   * @param {String} remotePath - remote path, may be relative
   * @returns {Promise<String>} - remote absolute path or ''
   */
  realPath(remotePath) {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'realPath', reject);
      this.debugMsg(`realPath -> ${remotePath}`);
      if (haveConnection(this, 'realPath', reject)) {
        this.sftp.realpath(remotePath, (err, absPath) => {
          if (err) {
            this.debugMsg(`realPath Error: ${err.message} Code: ${err.code}`);
            if (err.code === 2) {
              resolve('');
            } else {
              reject(fmtError(`${err.message} ${remotePath}`, 'realPath', err.code));
            }
          }
          this.debugMsg(`realPath <- ${absPath}`);
          resolve(absPath);
        });
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'realPath');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Return the current workding directory path
   *
   * @returns {Promise<String>} - current remote working directory
   */
  cwd() {
    return this.realPath('.');
  }

  /**
   * Retrieves attributes for path
   *
   * @param {String} remotePath - a string containing the path to a file
   * @return {Promise<Object>} stats - attributes info
   */
  async stat(remotePath) {
    const _stat = (aPath) => {
      let listeners;
      return new Promise((resolve, reject) => {
        listeners = addTempListeners(this, '_stat', reject);
        this.debugMsg(`_stat: ${aPath}`);
        this.sftp.stat(aPath, (err, stats) => {
          if (err) {
            this.debugMsg(`_stat: Error ${err.message} code: ${err.code}`);
            if (err.code === 2 || err.code === 4) {
              reject(fmtError(`No such file: ${remotePath}`, '_stat', errorCode.notexist));
            } else {
              reject(fmtError(`${err.message} ${remotePath}`, '_stat', err.code));
            }
          } else {
            let result = {
              mode: stats.mode,
              uid: stats.uid,
              gid: stats.gid,
              size: stats.size,
              accessTime: stats.atime * 1000,
              modifyTime: stats.mtime * 1000,
              isDirectory: stats.isDirectory(),
              isFile: stats.isFile(),
              isBlockDevice: stats.isBlockDevice(),
              isCharacterDevice: stats.isCharacterDevice(),
              isSymbolicLink: stats.isSymbolicLink(),
              isFIFO: stats.isFIFO(),
              isSocket: stats.isSocket(),
            };
            this.debugMsg('_stat: stats <- ', result);
            resolve(result);
          }
        });
      }).finally(() => {
        removeTempListeners(this, listeners, '_stat');
      });
    };

    try {
      haveConnection(this, 'stat');
      let absPath = await normalizeRemotePath(this, remotePath);
      return _stat(absPath);
    } catch (err) {
      this._resetEventFlags();
      throw err.custom ? err : fmtError(err, 'stat', err.code);
    }
  }

  /**
   * @async
   *
   * Tests to see if an object exists. If it does, return the type of that object
   * (in the format returned by list). If it does not exist, return false.
   *
   * @param {string} remotePath - path to the object on the sftp server.
   *
   * @return {Promise<Boolean|String>} returns false if object does not exist. Returns type of
   *                   object if it does
   */
  async exists(remotePath) {
    try {
      if (haveConnection(this, 'exists')) {
        if (remotePath === '.') {
          this.debugMsg('exists: . = d');
          return 'd';
        }
        let absPath = await normalizeRemotePath(this, remotePath);
        try {
          this.debugMsg(`exists: ${remotePath} -> ${absPath}`);
          let info = await this.stat(absPath);
          this.debugMsg('exists: <- ', info);
          if (info.isDirectory) {
            this.debugMsg(`exists: ${remotePath} = d`);
            return 'd';
          }
          if (info.isSymbolicLink) {
            this.debugMsg(`exists: ${remotePath} = l`);
            return 'l';
          }
          if (info.isFile) {
            this.debugMsg(`exists: ${remotePath} = -`);
            return '-';
          }
          this.debugMsg(`exists: ${remotePath} = false`);
          return false;
        } catch (err) {
          if (err.code === errorCode.notexist) {
            this.debugMsg(`exists: ${remotePath} = false errorCode = ${err.code}`);
            return false;
          }
          this.debugMsg(`exists: throw error ${err.message} ${err.code}`);
          throw err;
        }
      }
      this.debugMsg(`exists: default ${remotePath} = false`);
      return false;
    } catch (err) {
      this._resetEventFlags();
      throw err.custom ? err : fmtError(err, 'exists', err.code);
    }
  }

  /**
   * @async
   *
   * List contents of a remote directory. If a pattern is provided,
   * filter the results to only include files with names that match
   * the supplied pattern. Return value is an array of file entry
   * objects that include properties for type, name, size, modifiyTime,
   * accessTime, rights {user, group other}, owner and group.
   *
   * @param {String} remotePath - path to remote directory
   * @param {RegExp} pattern - regular expression to match filenames
   * @returns {Promise<Array>} array of file description objects
   */
  list(remotePath, pattern = /.*/) {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'list', reject);
      if (haveConnection(this, 'list', reject)) {
        const reg = /-/gi;
        this.debugMsg(`list: ${remotePath} filter: ${pattern}`);
        this.sftp.readdir(remotePath, (err, fileList) => {
          if (err) {
            this.debugMsg(`list: Error ${err.message} code: ${err.code}`);
            reject(fmtError(`${err.message} ${remotePath}`, 'list', err.code));
          } else {
            let newList = [];
            // reset file info
            if (fileList) {
              newList = fileList.map((item) => {
                return {
                  type: item.longname.slice(0, 1),
                  name: item.filename,
                  size: item.attrs.size,
                  modifyTime: item.attrs.mtime * 1000,
                  accessTime: item.attrs.atime * 1000,
                  rights: {
                    user: item.longname.slice(1, 4).replace(reg, ''),
                    group: item.longname.slice(4, 7).replace(reg, ''),
                    other: item.longname.slice(7, 10).replace(reg, ''),
                  },
                  owner: item.attrs.uid,
                  group: item.attrs.gid,
                  longname: item.longname
                };
              });
            }
            // provide some compatibility for auxList
            let regex;
            if (pattern instanceof RegExp) {
              regex = pattern;
            } else {
              let newPattern = pattern.replace(/\*([^*])*?/gi, '.*');
              regex = new RegExp(newPattern);
            }
            let filteredList = newList.filter((item) => regex.test(item.name));
            this.debugMsg('list: result: ', filteredList);
            resolve(filteredList);
          }
        });
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'list');
      this._resetEventFlags();
    });
  }

  /**
   * get file
   *
   * If a dst argument is provided, it must be either a string, representing the
   * local path to where the data will be put, a stream, in which case data is
   * piped into the stream or undefined, in which case the data is returned as
   * a Buffer object.
   *
   * @param {String} remotePath - remote file path
   * @param {string|stream|undefined} dst - data destination
   * @param {Object} options - options object with supported properties of readStreamOptions,
   *                          writeStreamOptions and pipeOptions.
   *
   * @return {Promise<String|Stream|Buffer>}
   */
  get(
    remotePath,
    dst,
    options = { readStreamOptions: {}, writeStreamOptions: {}, pipeOptions: {} }
  ) {
    let rdr, wtr, listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'get', reject);
      if (haveConnection(this, 'get', reject)) {
        this.debugMsg(`get -> ${remotePath} `, options);
        rdr = this.sftp.createReadStream(
          remotePath,
          options.readStreamOptions ? options.readStreamOptions : {}
        );
        rdr.once('error', (err) => {
          reject(fmtError(`${err.message} ${remotePath}`, 'get', err.code));
        });
        if (dst === undefined) {
          // no dst specified, return buffer of data
          this.debugMsg('get returning buffer of data');
          wtr = concat((buff) => {
            //rdr.removeAllListeners('error');
            resolve(buff);
          });
        } else {
          if (typeof dst === 'string') {
            // dst local file path
            this.debugMsg('get returning local file');
            const localCheck = haveLocalCreate(dst);
            if (!localCheck.status) {
              return reject(
                fmtError(`Bad path: ${dst}: ${localCheck.details}`, 'get', localCheck.code)
              );
            }
            wtr = fs.createWriteStream(
              dst,
              options.writeStreamOptions ? options.writeStreamOptions : {}
            );
          } else {
            this.debugMsg('get returning data into supplied stream');
            wtr = dst;
          }
          wtr.once('error', (err) => {
            reject(
              fmtError(`${err.message} ${typeof dst === 'string' ? dst : ''}`, 'get', err.code)
            );
          });
          if (
            Object.hasOwnProperty.call(options, 'pipeOptions') &&
            Object.hasOwnProperty.call(options.pipeOptions, 'end') &&
            !options.pipeOptions.end
          ) {
            rdr.once('end', () => {
              this.debugMsg('get resolved on reader end event');
              if (typeof dst === 'string') {
                resolve(dst);
              } else {
                resolve(wtr);
              }
            });
          } else {
            wtr.once('finish', () => {
              this.debugMsg('get resolved on writer finish event');
              if (typeof dst === 'string') {
                resolve(dst);
              } else {
                resolve(wtr);
              }
            });
          }
        }
        rdr.pipe(wtr, options.pipeOptions ? options.pipeOptions : {});
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'get');
      this._resetEventFlags();
      if (
        rdr &&
        Object.hasOwnProperty.call(options, 'readStreamOptions') &&
        Object.hasOwnProperty.call(options.readStreamOptions, 'autoClose') &&
        options.readStreamOptions.autoClose === false
      ) {
        rdr.destroy();
      }
      if (
        wtr &&
        Object.hasOwnProperty.call(options, 'writeStreamOptions') &&
        Object.hasOwnProperty.call(options.writeStreamOptions, 'autoClose') &&
        options.writeStreamOptions.autoClose === false &&
        typeof dst === 'string'
      ) {
        wtr.destroy();
      }
    });
  }

  /**
   * Use SSH2 fastGet for downloading the file.
   * Downloads a file at remotePath to localPath using parallel reads
   * for faster throughput.
   *
   * @param {String} remotePath
   * @param {String} localPath
   * @param {Object} options
   * @return {Promise<String>} the result of downloading the file
   */
  async fastGet(remotePath, localPath, options) {
    try {
      const ftype = await this.exists(remotePath);
      if (ftype !== '-') {
        const msg =
          ftype === false ? `No such file ${remotePath}` : `Not a regular file ${remotePath}`;
        let err = new Error(msg);
        err.code = errorCode.badPath;
        throw err;
      }
      const localCheck = haveLocalCreate(localPath);
      if (!localCheck.status) {
        let err = new Error(`Bad path: ${localPath}: ${localCheck.details}`);
        err.code = errorCode.badPath;
        throw err;
      }
      let listeners;
      let rslt = await new Promise((resolve, reject) => {
        listeners = addTempListeners(this, 'fastGet', reject);
        if (haveConnection(this, 'fastGet', reject)) {
          this.debugMsg(`fastGet -> remote: ${remotePath} local: ${localPath} `, options);
          this.sftp.fastGet(remotePath, localPath, options, (err) => {
            if (err) {
              this.debugMsg(`fastGet error ${err.message} code: ${err.code}`);
              reject(err);
            }
            resolve(`${remotePath} was successfully download to ${localPath}!`);
          });
        }
      }).finally(() => {
        removeTempListeners(this, listeners, 'fastGet');
      });
      return rslt;
    } catch (err) {
      this._resetEventFlags();
      throw fmtError(err, 'fastGet');
    }
  }

  /**
   * Use SSH2 fastPut for uploading the file.
   * Uploads a file from localPath to remotePath using parallel reads
   * for faster throughput.
   *
   * See 'fastPut' at
   * https://github.com/mscdex/ssh2-streams/blob/master/SFTPStream.md
   *
   * @param {String} localPath
   * @param {String} remotePath
   * @param {Object} options
   * @return {Promise<String>} the result of downloading the file
   */
  fastPut(localPath, remotePath, options) {
    let listeners;
    this.debugMsg(`fastPut -> local ${localPath} remote ${remotePath}`);
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'fastPut', reject);
      const localCheck = haveLocalAccess(localPath);
      if (!localCheck.status) {
        reject(
          fmtError(`Bad path: ${localPath}: ${localCheck.details}`, 'fastPut', localCheck.code)
        );
      } else if (localCheck.status && localExists(localPath) === 'd') {
        reject(
          fmtError(`Bad path: ${localPath} not a regular file`, 'fastPut', errorCode.badPath)
        );
      } else if (haveConnection(this, 'fastPut', reject)) {
        this.debugMsg(
          `fastPut -> local: ${localPath} remote: ${remotePath} opts: ${JSON.stringify(
            options
          )}`
        );
        this.sftp.fastPut(localPath, remotePath, options, (err) => {
          if (err) {
            this.debugMsg(`fastPut error ${err.message} ${err.code}`);
            reject(
              fmtError(
                `${err.message} Local: ${localPath} Remote: ${remotePath}`,
                'fastPut',
                err.code
              )
            );
          }
          this.debugMsg('fastPut file transferred');
          resolve(`${localPath} was successfully uploaded to ${remotePath}!`);
        });
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'fastPut');
      this._resetEventFlags();
    });
  }

  /**
   * Create a file on the remote server. The 'src' argument
   * can be a buffer, string or read stream. If 'src' is a string, it
   * should be the path to a local file.
   *
   * @param  {String|Buffer|stream} localSrc - source data to use
   * @param  {String} remotePath - path to remote file
   * @param  {Object} options - options used for read, write stream and pipe configuration
   *                            value supported by node. Allowed properties are readStreamOptions,
   *                            writeStreamOptions and pipeOptions.
   * @return {Promise<String>}
   */
  put(
    localSrc,
    remotePath,
    options = {
      readStreamOptions: {},
      writeStreamOptions: { autoClose: true },
      pipeOptions: {},
    }
  ) {
    let wtr, rdr, listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'put', reject);
      if (typeof localSrc === 'string') {
        const localCheck = haveLocalAccess(localSrc);
        if (!localCheck.status) {
          this.debugMsg(`put: local source check error ${localCheck.details}`);
          return reject(
            fmtError(`Bad path: ${localSrc}: ${localCheck.details}`, 'put', localCheck.code)
          );
        }
      }
      if (haveConnection(this, 'put')) {
        wtr = this.sftp.createWriteStream(
          remotePath,
          options.writeStreamOptions ? { ...options.writeStreamOptions, autoClose: true } : {}
        );
        wtr.once('error', (err) => {
          this.debugMsg(`put: write stream error ${err.message}`);
          reject(fmtError(`${err.message} ${remotePath}`, 'put', err.code));
        });
        wtr.once('close', () => {
          this.debugMsg('put: promise resolved');
          resolve(`Uploaded data stream to ${remotePath}`);
        });
        if (localSrc instanceof Buffer) {
          this.debugMsg('put source is a buffer');
          wtr.end(localSrc);
        } else {
          if (typeof localSrc === 'string') {
            this.debugMsg(`put source is a file path: ${localSrc}`);
            rdr = fs.createReadStream(
              localSrc,
              options.readStreamOptions ? options.readStreamOptions : {}
            );
          } else {
            this.debugMsg('put source is a stream');
            rdr = localSrc;
          }
          rdr.once('error', (err) => {
            this.debugMsg(`put: read stream error ${err.message}`);
            reject(
              fmtError(
                `${err.message} ${typeof localSrc === 'string' ? localSrc : ''}`,
                'put',
                err.code
              )
            );
          });
          rdr.pipe(wtr, options.pipeOptions ? options.pipeOptions : {});
        }
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'put');
      this._resetEventFlags();
      if (
        rdr &&
        Object.hasOwnProperty.call(options, 'readStreamOptions') &&
        Object.hasOwnProperty.call(options.readStreamOptions, 'autoClose') &&
        options.readStreamOptions.autoClose === false &&
        typeof localSrc === 'string'
      ) {
        rdr.destroy();
      }
    });
  }

  /**
   * Append to an existing remote file
   *
   * @param  {Buffer|stream} input
   * @param  {String} remotePath
   * @param  {Object} options
   * @return {Promise<String>}
   */
  async append(input, remotePath, options = {}) {
    const fileType = await this.exists(remotePath);
    if (fileType && fileType === 'd') {
      throw fmtError(
        `Bad path: ${remotePath}: cannot append to a directory`,
        'append',
        errorCode.badPath
      );
    }
    let listeners;
    return await new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'append', reject);
      if (haveConnection(this, 'append', reject)) {
        if (typeof input === 'string') {
          reject(fmtError('Cannot append one file to another', 'append'));
        } else {
          this.debugMsg(`append -> remote: ${remotePath} `, options);
          options.flags = 'a';
          let stream = this.sftp.createWriteStream(remotePath, options);
          stream.on('error', (err_1) => {
            reject(fmtError(`${err_1.message} ${remotePath}`, 'append', err_1.code));
          });
          stream.on('finish', () => {
            resolve(`Appended data to ${remotePath}`);
          });
          if (input instanceof Buffer) {
            stream.write(input);
            stream.end();
          } else {
            input.pipe(stream);
          }
        }
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'append');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Make a directory on remote server
   *
   * @param {string} remotePath - remote directory path.
   * @param {boolean} recursive - if true, recursively create directories
   * @return {Promise<String>}
   */
  async mkdir(remotePath, recursive = false) {
    const _mkdir = (p) => {
      let listeners;
      return new Promise((resolve, reject) => {
        listeners = addTempListeners(this, '_mkdir', reject);
        this.debugMsg(`_mkdir: create ${p}`);
        this.sftp.mkdir(p, (err) => {
          if (err) {
            this.debugMsg(`_mkdir: Error ${err.message} code: ${err.code}`);
            if (err.code === 4) {
              //fix for windows dodgy error messages
              let error = new Error(`Bad path: ${p} permission denied`);
              error.code = errorCode.badPath;
              reject(error);
            } else if (err.code === 2) {
              let error = new Error(`Bad path: ${p} parent not a directory or not exist`);
              error.code = errorCode.badPath;
              reject(error);
            } else {
              reject(err);
            }
          } else {
            this.debugMsg('_mkdir: directory created');
            resolve(`${p} directory created`);
          }
        });
      }).finally(() => {
        removeTempListeners(this, listeners, '_mkdir');
        this._resetEventFlags();
      });
    };

    try {
      haveConnection(this, 'mkdir');
      let rPath = await normalizeRemotePath(this, remotePath);
      let targetExists = await this.exists(rPath);
      if (targetExists && targetExists !== 'd') {
        let error = new Error(`Bad path: ${rPath} already exists as a file`);
        error.code = errorCode.badPath;
        throw error;
      } else if (targetExists) {
        return `${rPath} already exists`;
      }
      if (!recursive) {
        return await _mkdir(rPath);
      }
      let dir = parse(rPath).dir;
      if (dir) {
        let dirExists = await this.exists(dir);
        if (!dirExists) {
          await this.mkdir(dir, true);
        } else if (dirExists !== 'd') {
          let error = new Error(`Bad path: ${dir} not a directory`);
          error.code = errorCode.badPath;
          throw error;
        }
      }
      return await _mkdir(rPath);
    } catch (err) {
      throw fmtError(`${err.message}`, 'mkdir', err.code);
    }
  }

  /**
   * @async
   *
   * Remove directory on remote server
   *
   * @param {string} remotePath - path to directory to be removed
   * @param {boolean} recursive - if true, remove directories/files in target
   *                             directory
   * @return {Promise<String>}
   */
  async rmdir(remotePath, recursive = false) {
    const _delete = (remotePath) => {
      return new Promise((resolve, reject) => {
        this.sftp.unlink(remotePath, (err) => {
          if (err && err.code !== 2) {
            reject(fmtError(`${err.message} ${remotePath}`, 'rmdir', err.code));
          }
          resolve(true);
        });
      });
    };

    const _rmdir = (p) => {
      return new Promise((resolve, reject) => {
        this.debugMsg(`rmdir -> ${p}`);
        this.sftp.rmdir(p, (err) => {
          if (err) {
            this.debugMsg(`rmdir error ${err.message} code: ${err.code}`);
            reject(fmtError(`${err.message} ${p}`, 'rmdir', err.code));
          }
          resolve('Successfully removed directory');
        });
      }).finally(() => {
        removeTempListeners(this, listeners, '_rmdir');
      });
    };

    const _dormdir = async (p, recur) => {
      try {
        if (recur) {
          let list = await this.list(p);
          if (list.length) {
            let files = list.filter((item) => item.type !== 'd');
            let dirs = list.filter((item) => item.type === 'd');
            this.debugMsg('rmdir contents (files): ', files);
            this.debugMsg('rmdir contents (dirs): ', dirs);
            for (let d of dirs) {
              await _dormdir(`${p}${this.remotePathSep}${d.name}`, true);
            }
            let promiseList = [];
            for (let f of files) {
              promiseList.push(_delete(`${p}${this.remotePathSep}${f.name}`));
            }
            await Promise.all(promiseList);
          }
        }
        return await _rmdir(p);
      } catch (err) {
        throw err.custom ? err : fmtError(err, '_dormdir', err.code);
      }
    };

    let listeners;
    try {
      listeners = addTempListeners(this, 'rmdir');
      haveConnection(this, 'rmdir');
      let absPath = await normalizeRemotePath(this, remotePath);
      let dirStatus = await this.exists(absPath);
      if (dirStatus && dirStatus !== 'd') {
        throw fmtError(`Bad path: ${absPath} not a directory`, 'rmdir', errorCode.badPath);
      } else if (!dirStatus) {
        throw fmtError(`Bad path: ${absPath} No such file`, 'rmdir', errorCode.badPath);
      } else {
        return await _dormdir(absPath, recursive);
      }
    } catch (err) {
      this._resetEventFlags();
      throw err.custom ? err : fmtError(err, 'rmdir', err.code);
    } finally {
      removeTempListeners(this, listeners, 'rmdir');
    }
  }

  /**
   * @async
   *
   * Delete a file on the remote SFTP server
   *
   * @param {string} remotePath - path to the file to delete
   * @param {boolean} notFoundOK - if true, ignore errors for missing target.
   *                               Default is false.
   * @return {Promise<String>} with string 'Successfully deleted file' once resolved
   *
   */
  delete(remotePath, notFoundOK = false) {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'delete', reject);
      if (haveConnection(this, 'delete', reject)) {
        this.debugMsg(`delete -> ${remotePath}`);
        this.sftp.unlink(remotePath, (err) => {
          if (err) {
            this.debugMsg(`delete error ${err.message} code: ${err.code}`);
            if (notFoundOK && err.code === 2) {
              this.debugMsg('delete ignore missing target error');
              resolve(`Successfully deleted ${remotePath}`);
            } else {
              reject(fmtError(`${err.message} ${remotePath}`, 'delete', err.code));
            }
          }
          resolve(`Successfully deleted ${remotePath}`);
        });
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'delete');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Rename a file on the remote SFTP repository
   *
   * @param {string} fromPath - path to the file to be renamed.
   * @param {string} toPath - path to the new name.
   *
   * @return {Promise<String>}
   *
   */
  rename(fromPath, toPath) {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'rename', reject);
      if (haveConnection(this, 'rename', reject)) {
        this.debugMsg(`rename -> ${fromPath} ${toPath}`);
        this.sftp.rename(fromPath, toPath, (err) => {
          if (err) {
            this.debugMsg(`rename error ${err.message} code: ${err.code}`);
            reject(
              fmtError(`${err.message} From: ${fromPath} To: ${toPath}`, 'rename', err.code)
            );
          }
          resolve(`Successfully renamed ${fromPath} to ${toPath}`);
        });
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'rename');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Rename a file on the remote SFTP repository using the SSH extension
   * posix-rename@openssh.com using POSIX atomic rename. (Introduced in SSH 4.8)
   *
   * @param {string} fromPath - path to the file to be renamed.
   * @param {string} toPath - path  the new name.
   *
   * @return {Promise<String>}
   *
   */
  posixRename(fromPath, toPath) {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'posixRename', reject);
      if (haveConnection(this, 'posixRename', reject)) {
        this.debugMsg(`posixRename -> ${fromPath} ${toPath}`);
        this.sftp.ext_openssh_rename(fromPath, toPath, (err) => {
          if (err) {
            this.debugMsg(`posixRename error ${err.message} code: ${err.code}`);
            reject(
              fmtError(
                `${err.message} From: ${fromPath} To: ${toPath}`,
                'posixRename',
                err.code
              )
            );
          }
          resolve(`Successful POSIX rename ${fromPath} to ${toPath}`);
        });
      }
    }).finally(() => {
      removeTempListeners(this, listeners, 'posixRename');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Change the mode of a remote file on the SFTP repository
   *
   * @param {string} remotePath - path to the remote target object.
   * @param {number | string} mode - the new octal mode to set
   *
   * @return {Promise<String>}
   */
  chmod(remotePath, mode) {
    let listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'chmod', reject);
      this.debugMsg(`chmod -> ${remotePath} ${mode}`);
      this.sftp.chmod(remotePath, mode, (err) => {
        if (err) {
          reject(fmtError(`${err.message} ${remotePath}`, 'chmod', err.code));
        }
        resolve('Successfully change file mode');
      });
    }).finally(() => {
      removeTempListeners(this, listeners, 'chmod');
      this._resetEventFlags();
    });
  }

  /**
   * @async
   *
   * Upload the specified source directory to the specified destination
   * directory. All regular files and sub-directories are uploaded to the remote
   * server.
   * @param {String} srcDir - local source directory
   * @param {String} dstDir - remote destination directory
   * @param {function(String,Boolean):Boolean} filter - (Optional) The first argument is the full path of the item to be uploaded and the second argument is a boolean, which will be true if the target path is for a directory.  If the function returns true, the item will be uploaded 
   * @returns {Promise<String>}
   */
  async uploadDir(srcDir, dstDir, filter) {
    try {
      this.debugMsg(`uploadDir -> SRC = ${srcDir} DST = ${dstDir}`);
      haveConnection(this, 'uploadDir');
      //let absSrcDir = fs.realpathSync(srcDir);
      let absDstDir = await normalizeRemotePath(this, dstDir);

      this.debugMsg(`uploadDir <- SRC = ${srcDir} DST = ${absDstDir}`);
      const srcType = localExists(srcDir);
      if (!srcType) {
        throw fmtError(`Bad path: ${srcDir} not exist`, 'uploadDir', errorCode.badPath);
      }
      if (srcType !== 'd') {
        throw fmtError(`Bad path: ${srcDir}: not a directory`, 'uploadDir', errorCode.badPath);
      }
      let dstStatus = await this.exists(absDstDir);
      if (dstStatus && dstStatus !== 'd') {
        this.debugMsg(`UploadDir: DST ${absDstDir} exists but not a directory`);
        throw fmtError(
          `Bad path ${absDstDir} Not a directory`,
          'uploadDir',
          errorCode.badPath
        );
      }
      if (!dstStatus) {
        this.debugMsg(`UploadDir: Creating directory ${absDstDir}`);
        await this.mkdir(absDstDir, true);
      }
      let dirEntries = fs.readdirSync(srcDir, {
        encoding: 'utf8',
        withFileTypes: true,
      });
      if (filter) {
        dirEntries = dirEntries.filter((item) =>
          filter(join(srcDir, item.name), item.isDirectory())
        );
      }
      for (let e of dirEntries) {
        let newSrc = join(srcDir, e.name);
        let newDst = `${absDstDir}${this.remotePathSep}${e.name}`;
        if (e.isDirectory()) {
          await this.uploadDir(newSrc, newDst, filter);
        } else if (e.isFile()) {
          await this.put(newSrc, newDst);
          this.client.emit('upload', { source: newSrc, destination: newDst });
        } else {
          this.debugMsg(`uploadDir: File ignored: ${e.name} not a regular file`);
        }
      }
      return `${srcDir} uploaded to ${absDstDir}`;
    } catch (err) {
      this._resetEventFlags();
      throw err.custom ? err : fmtError(err, 'uploadDir');
    }
  }

  /**
   * @async
   *
   * Download the specified source directory to the specified destination
   * directory. All regular files and sub-directories are downloaded to the local
   * file system.
   * @param {String} srcDir - remote source directory
   * @param {String} dstDir - local destination directory
   * @param {function(String,Boolean):Boolean} filter - (Optional) The first argument is the full path of the item to be downloaded and the second argument is a boolean, which will be true if the target path is for a directory.  If the function returns true, the item will be downloaded 
   * @returns {Promise<String>}
   */
  async downloadDir(srcDir, dstDir, filter) {
    try {
      this.debugMsg(`downloadDir -> ${srcDir} ${dstDir}`);
      haveConnection(this, 'downloadDir');
      let fileList = await this.list(srcDir);
      if (filter) {
        fileList = fileList.filter((item) =>
          filter(
            `${srcDir}${this.remotePathSep}${item.name}`,
            item.type === 'd' ? true : false
          )
        );
      }
      const localCheck = haveLocalCreate(dstDir);
      if (!localCheck.status && localCheck.details === 'permission denied') {
        throw fmtError(
          `Bad path: ${dstDir}: ${localCheck.details}`,
          'downloadDir',
          localCheck.code
        );
      } else if (localCheck.status && !localCheck.type) {
        fs.mkdirSync(dstDir, { recursive: true });
      } else if (localCheck.status && localCheck.type !== 'd') {
        throw fmtError(
          `Bad path: ${dstDir}: not a directory`,
          'downloadDir',
          errorCode.badPath
        );
      }
      for (let f of fileList) {
        let newSrc = `${srcDir}${this.remotePathSep}${f.name}`;
        let newDst = join(dstDir, f.name);
        if (f.type === 'd') {
          await this.downloadDir(newSrc, newDst, filter);
        } else if (f.type === '-') {
          await this.get(newSrc, newDst);
          this.client.emit('download', { source: newSrc, destination: newDst });
        } else {
          this.debugMsg(`downloadDir: File ignored: ${f.name} not regular file`);
        }
      }
      return `${srcDir} downloaded to ${dstDir}`;
    } catch (err) {
      this._resetEventFlags();
      throw err.custom ? err : fmtError(err, 'downloadDir', err.code);
    }
  }

  /**
   * @async
   *
   * End the SFTP connection
   *
   * @returns {Promise<Boolean>}
   */
  end() {
    let endCloseHandler, listeners;
    return new Promise((resolve, reject) => {
      listeners = addTempListeners(this, 'end', reject);
      this.endCalled = true;
      endCloseHandler = () => {
        this.sftp = undefined;
        this.debugMsg('end: Connection closed');
        resolve(true);
      };
      this.on('close', endCloseHandler);
      if (haveConnection(this, 'end', reject)) {
        this.debugMsg('end: Have connection - calling end()');
        this.client.end();
      }
    }).finally(() => {
      this.debugMsg('end: finally clause fired');
      removeTempListeners(this, listeners, 'end');
      this.removeListener('close', endCloseHandler);
      this.endCalled = false;
      this._resetEventFlags();
    });
  }
}

module.exports = SftpClient;

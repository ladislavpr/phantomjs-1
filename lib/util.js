/**
 * @fileoverview Package-private helpers for the installer.
 */

'use strict'

var cp = require('child_process')
var fs = require('fs-extra')
var hasha = require('hasha')
var helper = require('./phantomjs')
var kew = require('kew')
var path = require('path')

var DEFAULT_CDN = 'https://github.com/Medium/phantomjs/releases/download/v2.1.1'
var libPath = __dirname

/**
 * Given a lib/location file of a PhantomJS previously installed with NPM,
 * is there a valid PhantomJS binary at this lib/location.
 * @return {Promise<string>} resolved location of phantomjs binary on success
 */
function findValidPhantomJsBinary(libPath) {
  return kew.fcall(function () {
    var libModule = require(libPath)
    if (libModule.location &&
        getTargetPlatform() == libModule.platform &&
        getTargetArch() == libModule.arch) {
      var resolvedLocation = path.resolve(path.dirname(libPath), libModule.location)
      if (fs.statSync(resolvedLocation)) {
        return checkPhantomjsVersion(resolvedLocation).then(function (matches) {
          if (matches) {
            return kew.resolve(resolvedLocation)
          }
        })
      }
    }
    return false
  }).fail(function () {
    return false
  })
}

/**
 * Check to make sure a given binary is the right version.
 * @return {kew.Promise.<boolean>}
 */
function checkPhantomjsVersion(phantomPath) {
  console.log('Found PhantomJS at', phantomPath, '...verifying')
  return kew.nfcall(cp.execFile, phantomPath, ['--version']).then(function (stdout) {
    var version = stdout.trim()
    if (helper.version == version) {
      return true
    } else {
      console.log('PhantomJS detected, but wrong version', stdout.trim(), '@', phantomPath + '.')
      return false
    }
  }).fail(function (err) {
    console.error('Error verifying phantomjs, continuing', err)
    return false
  })
}

/**
 * Writes the location file with location and platform/arch metadata about the
 * binary.
 */
function writeLocationFile(location) {
  console.log('Writing location.js file')
  if (getTargetPlatform() === 'win32') {
    location = location.replace(/\\/g, '\\\\')
  }

  var platform = getTargetPlatform()
  var arch = getTargetArch()

  var contents = 'module.exports.location = "' + location + '"\n'

  if (/^[a-zA-Z0-9]*$/.test(platform) && /^[a-zA-Z0-9]*$/.test(arch)) {
    contents +=
        'module.exports.platform = "' + getTargetPlatform() + '"\n' +
        'module.exports.arch = "' + getTargetArch() + '"\n'
  }

  fs.writeFileSync(path.join(libPath, 'location.js'), contents)
}

/**
 * @return {?{url: string, checksum: string}} Get the download URL and expected
 *     SHA-256 checksum for phantomjs.  May return null if no download url exists.
 */
function getDownloadSpec() {
  var checksum = ''

  var platform = getTargetPlatform()
  var arch = getTargetArch()
  if (platform === 'linux' && arch === 'x64') {
    downloadUrl = 'https://github.com/astefanutti/decktape/releases/download/v1.0.0/phantomjs-linux-x86-64'
    checksum = '47a37457cb2a5c2bcbca02e36eec4ee67784e528'
  } /*else if (platform === 'linux' && arch == 'ia32') {
    downloadUrl += 'linux-i686.tar.bz2'
    checksum = '80e03cfeb22cc4dfe4e73b68ab81c9fdd7c78968cfd5358e6af33960464f15e3'
  } */
  else if (platform === 'darwin' || platform === 'openbsd' || platform === 'freebsd') {
    downloadUrl = 'https://github.com/astefanutti/decktape/releases/download/v1.0.0/phantomjs-osx-cocoa-x86-64'
    checksum = '9ff2e1bf4a3aeeaf95ea626b8280e7425a193fbc'
  } else if (platform === 'win32') {
    downloadUrl = 'https://github.com/astefanutti/decktape/releases/download/v1.0.0/phantomjs-msvc2013-x86.exe'
    checksum = '294bfe6a00b268a94cee941578eb7bd7b06b6468'
  } else {
    return null
  }
  return {url: downloadUrl, checksum: checksum}
}

/**
 * Check to make sure that the file matches the checksum.
 * @param {string} fileName
 * @param {string} checksum
 * @return {Promise.<boolean>}
 */
function verifyChecksum(fileName, checksum) {
  return kew.resolve(hasha.fromFile(fileName, {algorithm: 'sha256'})).then(function (hash) {
    var result = checksum == hash
    if (result) {
      console.log('Verified checksum of previously downloaded file')
    } else {
      console.log('Checksum did not match')
    }
    return result
  }).fail(function (err) {
    console.error('Failed to verify checksum: ', err)
    return false
  })
}

/**
 * @return {string}
 */
function getTargetPlatform() {
  return process.env.PHANTOMJS_PLATFORM || process.platform
}

/**
 * @return {string}
 */
function getTargetArch() {
  return process.env.PHANTOMJS_ARCH || process.arch
}

module.exports = {
  checkPhantomjsVersion: checkPhantomjsVersion,
  getDownloadSpec: getDownloadSpec,
  getTargetPlatform: getTargetPlatform,
  getTargetArch: getTargetArch,
  findValidPhantomJsBinary: findValidPhantomJsBinary,
  verifyChecksum: verifyChecksum,
  writeLocationFile: writeLocationFile
}

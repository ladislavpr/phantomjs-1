// Copyright 2012 The Obvious Corporation.

/*
 * This simply fetches the right version of phantom for the current platform.
 */

'use strict'

var requestProgress = require('request-progress')
var progress = require('progress')
var shell = require('shelljs')
var cp = require('child_process')
var fs = require('fs-extra')
var helper = require('./lib/phantomjs')
var kew = require('kew')
var path = require('path')
var request = require('request')
var url = require('url')
var util = require('./lib/util')
var which = require('which')
var os = require('os')

var originalPath = process.env.PATH

var checkPhantomjsVersion = util.checkPhantomjsVersion
var getTargetPlatform = util.getTargetPlatform
var getTargetArch = util.getTargetArch
var getDownloadSpec = util.getDownloadSpec
var findValidPhantomJsBinary = util.findValidPhantomJsBinary
var verifyChecksum = util.verifyChecksum
var writeLocationFile = util.writeLocationFile

// If the process exits without going through exit(), then we did not complete.
var validExit = false

process.on('exit', function () {
  if (!validExit) {
    console.log('Install exited unexpectedly')
    exit(1)
  }
})

// NPM adds bin directories to the path, which will cause `which` to find the
// bin for this package not the actual phantomjs bin.  Also help out people who
// put ./bin on their path
process.env.PATH = helper.cleanPath(originalPath)

var libPath = path.join(__dirname, 'lib')
var pkgPath = path.join(libPath, 'phantom')
var phantomPath = null

// If the user manually installed PhantomJS, we want
// to use the existing version.
//
// Do not re-use a manually-installed PhantomJS with
// a different version.
//
// Do not re-use an npm-installed PhantomJS, because
// that can lead to weird circular dependencies between
// local versions and global versions.
// https://github.com/Obvious/phantomjs/issues/85
// https://github.com/Medium/phantomjs/pull/184
kew.resolve(true)
  .then(tryPhantomjsInLib)
  .then(tryPhantomjsOnPath)
  .then(downloadPhantomjsBinary)
  .then(function() {
    var location = getTargetPlatform() === 'win32' ?
        path.join(pkgPath, 'bin', 'phantomjs.exe') :
        path.join(pkgPath, 'bin' ,'phantomjs')

    var relativeLocation = path.relative(libPath, location)
    writeLocationFile(relativeLocation)

    console.log('Done. Phantomjs binary available at', location)
    exit(0)
  })
  .fail(function (err) {
    console.error('Phantom installation failed', err, err.stack)
    exit(1)
  })
  /*
  .then(downloadPhantomjs)
  .then(extractDownload)
  .then(function (extractedPath) {
    return copyIntoPlace(extractedPath, pkgPath)
  })
  .then(function () {
    var location = getTargetPlatform() === 'win32' ?
        path.join(pkgPath, 'bin', 'phantomjs.exe') :
        path.join(pkgPath, 'bin' ,'phantomjs')

    try {
      // Ensure executable is executable by all users
      fs.chmodSync(location, '755')
    } catch (err) {
      if (err.code == 'ENOENT') {
        console.error('chmod failed: phantomjs was not successfully copied to', location)
        exit(1)
      }
      throw err
    }

    var relativeLocation = path.relative(libPath, location)
    writeLocationFile(relativeLocation)

    console.log('Done. Phantomjs binary available at', location)
    exit(0)
  })
  .fail(function (err) {
    console.error('Phantom installation failed', err, err.stack)
    exit(1)
  })
  */
function exit(code) {
  validExit = true
  process.env.PATH = originalPath
  process.exit(code || 0)
}


function findSuitableTempDirectory() {
  var now = Date.now()
  var candidateTmpDirs = [
    process.env.npm_config_tmp,
    os.tmpdir(),
    path.join(process.cwd(), 'tmp')
  ]

  for (var i = 0; i < candidateTmpDirs.length; i++) {
    var candidatePath = candidateTmpDirs[i]
    if (!candidatePath) continue

    try {
      candidatePath = path.join(path.resolve(candidatePath), 'phantomjs')
      fs.mkdirsSync(candidatePath, '0777')
      // Make double sure we have 0777 permissions; some operating systems
      // default umask does not allow write by default.
      fs.chmodSync(candidatePath, '0777')
      var testFile = path.join(candidatePath, now + '.tmp')
      fs.writeFileSync(testFile, 'test')
      fs.unlinkSync(testFile)
      return candidatePath
    } catch (e) {
      console.log(candidatePath, 'is not writable:', e.message)
    }
  }

  console.error('Can not find a writable tmp directory, please report issue ' +
      'on https://github.com/Medium/phantomjs/issues with as much ' +
      'information as possible.')
  exit(1)
}


function getRequestOptions() {
  var strictSSL = !!process.env.npm_config_strict_ssl
  if (process.version == 'v0.10.34') {
    console.log('Node v0.10.34 detected, turning off strict ssl due to https://github.com/joyent/node/issues/8894')
    strictSSL = false
  }

  var options = {
    uri: getDownloadUrl(),
    encoding: null, // Get response as a buffer
    followRedirect: true, // The default download path redirects to a CDN URL.
    headers: {},
    strictSSL: strictSSL
  }

  var proxyUrl = process.env.npm_config_https_proxy ||
      process.env.npm_config_http_proxy ||
      process.env.npm_config_proxy
  if (proxyUrl) {

    // Print using proxy
    var proxy = url.parse(proxyUrl)
    if (proxy.auth) {
      // Mask password
      proxy.auth = proxy.auth.replace(/:.*$/, ':******')
    }
    console.log('Using proxy ' + url.format(proxy))

    // Enable proxy
    options.proxy = proxyUrl
  }

  // Use the user-agent string from the npm config
  options.headers['User-Agent'] = process.env.npm_config_user_agent

  // Use certificate authority settings from npm
  var ca = process.env.npm_config_ca
  if (!ca && process.env.npm_config_cafile) {
    try {
      ca = fs.readFileSync(process.env.npm_config_cafile, {encoding: 'utf8'})
        .split(/\n(?=-----BEGIN CERTIFICATE-----)/g)

      // Comments at the beginning of the file result in the first
      // item not containing a certificate - in this case the
      // download will fail
      if (ca.length > 0 && !/-----BEGIN CERTIFICATE-----/.test(ca[0])) {
        ca.shift()
      }

    } catch (e) {
      console.error('Could not read cafile', process.env.npm_config_cafile, e)
    }
  }

  if (ca) {
    console.log('Using npmconf ca')
    options.agentOptions = {
      ca: ca
    }
    options.ca = ca
  }

  return options
}

function handleRequestError(error) {
  if (error && error.stack && error.stack.indexOf('SELF_SIGNED_CERT_IN_CHAIN') != -1) {
      console.error('Error making request, SELF_SIGNED_CERT_IN_CHAIN. ' +
          'Please read https://github.com/Medium/phantomjs#i-am-behind-a-corporate-proxy-that-uses-self-signed-ssl-certificates-to-intercept-encrypted-traffic')
      exit(1)
  } else if (error) {
    console.error('Error making request.\n' + error.stack + '\n\n' +
        'Please report this full log at https://github.com/Medium/phantomjs')
    exit(1)
  } else {
    console.error('Something unexpected happened, please report this full ' +
        'log at https://github.com/Medium/phantomjs')
    exit(1)
  }
}
/**
 * Check to see if the binary in lib is OK to use. If successful, exit the process.
 */
function tryPhantomjsInLib() {
  return kew.fcall(function () {
    return verifyChecksum(findValidPhantomJsBinary(path.resolve(__dirname, './lib/location.js')), downloadSpec.checksum)
  }).then(function (binaryLocation) {
    if (binaryLocation) {
      console.log('PhantomJS is previously installed at', binaryLocation)
      exit(0)
    }
  }).fail(function () {
    // silently swallow any errors
  })
}

/**
 * Check to see if the binary on PATH is OK to use. If successful, exit the process.
 */
function tryPhantomjsOnPath() {
  if (getTargetPlatform() != process.platform || getTargetArch() != process.arch) {
    console.log('Building for target platform ' + getTargetPlatform() + '/' + getTargetArch() +
                '. Skipping PATH search')
    return kew.resolve(false)
  }

  return kew.nfcall(which, 'phantomjs')
  .then(function (result) {
    phantomPath = result
    console.log('Considering PhantomJS found at', phantomPath)

    // Horrible hack to avoid problems during global install. We check to see if
    // the file `which` found is our own bin script.
    if (phantomPath.indexOf(path.join('npm', 'phantomjs')) !== -1) {
      console.log('Looks like an `npm install -g` on windows; skipping installed version.')
      return
    }

    var contents = fs.readFileSync(phantomPath, 'utf8')
    if (/NPM_INSTALL_MARKER/.test(contents)) {
      console.log('Looks like an `npm install -g`')

      var phantomLibPath = path.resolve(fs.realpathSync(phantomPath), '../../lib/location')
      return findValidPhantomJsBinary(phantomLibPath)
      .then(function (binaryLocation) {
        if (binaryLocation) {
          writeLocationFile(binaryLocation)
          console.log('PhantomJS linked at', phantomLibPath)
          exit(0)
        }
        console.log('Could not link global install, skipping...')
      })
    } else {
      console.log('PhantomJS is already installed on PATH at', phantomPath)
      exit(0)
    }
  }, function () {
    console.log('PhantomJS not found on PATH')
  })
  .fail(function (err) {
    console.error('Error checking path, continuing', err)
    return false
  })
}

/**
 * @return {?string} Get the download URL for phantomjs.
 *     May return null if no download url exists.
 */
function getDownloadUrl() {
  var spec = getDownloadSpec()
  return spec && spec.url
}


function downloadPhantomjsBinary() {
  var downloadSpec = getDownloadSpec()
  if (!downloadSpec) {
    console.error(
        'Unexpected platform or architecture: ' + getTargetPlatform() + '/' + getTargetArch() + '\n' +
        'It seems there is no binary available for your platform/architecture\n' +
        'Try to install PhantomJS globally')
    exit(1)
  }

  var downloadUrl = downloadSpec.url
  var downloadedFile


  return kew.fcall(function () {
  shell.mkdir('-p', 'lib/phantom/bin');
  shell.cd('lib/phantom/bin');
  getTargetPlatform() === 'win32' ?
  shell.exec('curl -L '+downloadUrl+' -o phantomjs.exe')
  : shell.exec('curl -L '+downloadUrl+' -o phantomjs');
  shell.chmod('+x', 'phantomjs');

  return 1; }).then(function() {
    console.log('PhantomJS installed successfully');
    return 1;
  })
}

// BlameStella Testrun
// 2012-04-06
//
// Usage: bin/phantomjs scripts/phantomjs/testrun.js URI

// (2012-11-23) SEE: https://github.com/wesleyhales/loadreport which is based on
//                   https://github.com/jamesgpearce/confess

// https://github.com/ariya/phantomjs/wiki/API-Reference

var screenshot_path = '/tmp'

try {
  phantom.injectJs('include/base.js');
} catch (err) {
  handleError(err);
}

if (system.args.length < 2) {
  console.log('Usage: testrun.js <URI> [JSON]');
  phantom.exit();
}

var uri = normalize_uri(system.args[1]),
    jsonopts = system.args[2];

try {
  if (jsonopts) {
    page.options = JSON.parse(jsonopts);
  } else {
    page.options = {
      // When supplied, will disable google tracking via window['ga-disable']
      // gaid: 'UA-XXXXXXX-N'
    }
  }

  page.address = uri;
  page.viewportSize = { width: page.options.width || 1024, height : page.options.height || 768};
  page.resources = [];

} catch (err) {
  handleError(err);
}

// Handle calls to console.log in page code
// There are cases where a page makes calls to console.log
// after it's loaded and even after we output the JSON. Be
// careful! (See http://space.com/)
page.onConsoleMessage = function (msg) {
  console.log('# CONSOLE: ' + msg);
};

// We use onInitialized for the start time.
// From: https://groups.google.com/d/msg/phantomjs/WnXZLIb_jVc/1kP2SAVq8qEJ
page.onInitialized = function () {
  try {
    var options = page.options;
    page.timingInitialize = page.evaluate(function (options) {
      (function () {
        document.addEventListener("DOMContentLoaded", function(){window.timingDOMContentLoaded = +new Date();}, false);
        // BUG: This event is not always fired. Test http://google.com for example.
        window.addEventListener("load", function(){window.timingOnLoad = +new Date();}, false);
        // TODO: https://developers.google.com/analytics/devguides/collection/gajs/#disable
        if (options.gaid && '' != options.gaid) {
          window['ga-account'] = options.gaid
          window['ga-disable-' + window['ga-account']] = true;
        }
      })();
      return +new Date();
    }, page.options); // Pass options to the evaluate function.
  } catch(err) {
    handleError(err);
  }
};

// Fired onInitialized
page.onLoadStarted = function () {
  try {
    // We don't currently use this timing anywhere else
    page.timingLoadStarted = +new Date();
    hardTimeout("typeof page.timingOnLoad != 'undefined'", function(elapsed) {
      console.log(json(createErrorHAR(page, "timeout", elapsed)));
      phantom.exit(0);
    }, 20000);
  } catch(err) {
    handleError(err);
  }
};

page.onResourceRequested = function (req) {
  // TODO (2012-12-11): No current way to skip files. Cool, new URI parser tho.
  //var uri = parseURI(document, req.url);
  //if ("www.google-analytics.com" == uri.hostname) {
  //  console.error(uri.hostname);
  //  page.evaluate(function() {
  //  });
  //}
  try {
    page.resources[req.id] = {
    request: req,
    startReply: null,
    endReply: null
    };
  } catch(err) {
    handleError(err);
  }
};

page.onResourceReceived = function (res) {
  try {
    if (res.stage === 'start') {
      page.resources[res.id].startReply = res;
    }
    if (res.stage === 'end') {
      page.resources[res.id].endReply = res;
    }
  } catch(err) {
    handleError(err);
  }
};

try {
  var globalStartTime = +new Date();
  page.open(page.address, function (status) {
    var har;

    if (status !== 'success') {
      console.log(JSON.stringify({"msg": "failed to load " + page.address, "success": false}));
    } else {
      var endTime = +new Date();
      page.title = page.evaluate(function () {
        return document.title;
      });
      page.timingDOMContentLoaded = page.evaluate(function () {
        return window.timingDOMContentLoaded;
      });
      page.timingOnLoad = page.evaluate(function () {
        return window.timingOnLoad;
      });
      page.gaDisabled = page.evaluate(function () {
        return window['ga-disable-' + window['ga-account']] || false;
      });
      // BUG: the onload event doesn't always fire. In these cases, we use
      // the time from when this function is called. It's usually within ~5ms
      // of the onload value but occasionally as high as 40ms. Seems to happen
      // most often for very fast pages. Example: http://google.com
      var onload_time_fix = (page.timingOnLoad || endTime);
      var timings = {
        "onContentReady": page.timingDOMContentLoaded - page.timingInitialize,
        "onLoad": onload_time_fix - page.timingInitialize
      };

      har = createHAR(page, endTime, timings);

      // Avoid transparent backgrounds
      page.evaluate(function() {
        if (document.body.bgColor == "")
           document.body.bgColor = 'white';
      });

      if (page.options.with_screenshots) {
        har.log.screenshot = screenshot_path + '/' + hex_sha1(json(har)) + '.png';
        page.render(har.log.screenshot);
        if (! fs.isReadable(har.log.screenshot)) {
          har.log.screenshot = '';
        }
      }

      // NOTE: We remove the callback to ensure there's no output AFTER the JSON.
      // This has actually happened! (See http://space.com/)
      page.onConsoleMessage = null;

      // NOTE: Must always print the HAR on a single line. This is a hack to get
      // around phantomjs noise where it will print messages while executing.
      console.log(json(har));
    }
    phantom.exit();
  });


} catch(err) {
  handleError(err);
}

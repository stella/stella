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

page.onInitialized = function () {
  try {
    var options = page.options;
    page.timingInitialize = page.evaluate(function (options) {
      (function () {

      // This won't be fired if the page loads very quickly (http://stellaaahhhh.com)
      document.addEventListener("DOMContentLoaded", function(){
        window.timingDOMContentLoaded = +new Date();
      }, false);

      // Callback example. Can be used here or by a webpage.
      //window.callPhantom('DOMContentLoaded');

      // NOTE: This is how to manually call an event
      //var DOMContentLoaded_event = document.createEvent("Event")
      //DOMContentLoaded_event.initEvent("DOMContentLoaded", true, true)
      //window.document.dispatchEvent(DOMContentLoaded_event)

      // This is often not fired.
      window.addEventListener("load", function(){
        window.timingOnLoad = +new Date();
      }, false);

      // Disable google analytics
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

// An example callback.
//page.onCallback = function(data) {
//  page.timingCallback = +new Date();
//  console.log('DOMContentLoaded');
//};

// Fired after onInitialized
// We use onLoadStarted for the start time.
page.onLoadStarted = function () {
  try {
    page.timingLoadStarted = +new Date();
    hardTimeout("typeof page.timingOnLoad != 'undefined'", function(elapsed) {
      console.log(json(createErrorHAR(page, "timeout", elapsed)));
      phantom.exit(0);
    }, 15000);
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

// Called just before the callback provided to page.open
page.onLoadFinished = function() {
  //console.log('page.onLoadFinished');
  page.timingOnLoadFinished = +new Date();
};

function runTestrun(status) {
  try {
  //if (status !== 'success') {
  //  console.log(JSON.stringify({"msg": "Cannot connect", "uri": page.address, "success": false, "status": page.title}));
  //} else {

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

    var onContentReady = (page.timingDOMContentLoaded) - page.timingLoadStarted;
    var onLoad = (page.timingOnLoad || page.timingOnLoadFinished) - page.timingLoadStarted;
    var timings = {
      "onContentReady": ((onContentReady > 0) ? onContentReady : onLoad),
      "onLoad": onLoad
    };

    // FOR DEBUGGING TIMINGS
    //console.log('start    ' + (page.timingLoadStarted-1357958380000))
    //console.log('content  ' + (page.timingDOMContentLoaded-1357958380000))
    //console.log('callback ' + (page.timingCallback-1357958380000))
    //console.log('load     ' + (page.timingOnLoad))
    //console.log('end      ' + (page.timingOnLoadFinished-1357958380000))
    //console.log('duration1 ' + ((page.timingDOMContentLoaded || page.timingInitialize) - page.timingLoadStarted))
    //console.log('duration2 ' + ((page.timingOnLoad || page.timingOnLoadFinished) - page.timingLoadStarted))

    // Avoid transparent backgrounds
    page.evaluate(function() {
      if (document.body.bgColor == "")
         document.body.bgColor = 'white';
    });

    var har = createHAR(page, page.timingOnLoadFinished, timings);

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

  //}

  } catch(err) {
    handleError(err);
  }

  phantom.exit();
}

try {
  page.open(page.address, runTestrun);
} catch(err) {
  handleError(err);
}


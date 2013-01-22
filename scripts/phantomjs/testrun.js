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

  if (page.options.username) {
    page.settings.userName = page.options.username;
    page.settings.password = page.options.password;
  }

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
    //console.log("# init");
    var v = page.evaluate(function (options) {
      var initStarted = +new Date();

      (function () {
      window.timingReadyState = {}

      // This won't be fired if the page loads very quickly (http://stellaaahhhh.com)
      window.document.addEventListener("DOMContentLoaded", function(){
        // Callback example. Can be used here or by a webpage.
        //window.callPhantom('DOMContentLoaded');
        window.timingDOMContentLoaded = +new Date();
      }, false);

      window.document.addEventListener("readystatechange", function(e){
        //console.log("statechange: " + window.document.readyState);
        window.timingReadyState[window.document.readyState] = +new Date();
      }, false);

      // NOTE: This is how to manually call an event
      //var DOMContentLoaded_event = document.createEvent("Event")
      //DOMContentLoaded_event.initEvent("DOMContentLoaded", true, true)
      //window.document.dispatchEvent(DOMContentLoaded_event)

      // This is often not fired (or we exit too soon).
      window.addEventListener("load", function(){
        window.timingOnLoad = +new Date();
      }, false);

      // Disable google analytics
      if (options.gaid && '' != options.gaid) {
        window['ga-account'] = options.gaid
        window['ga-disable-' + window['ga-account']] = true;
      }

      })();
      return initStarted;
    }, page.options); // Pass options to the evaluate function.

    if (!page.timingInitialize)
      page.timingInitialize = v;
  } catch(err) {
    handleError(err);
  }
};

// An example callback.
//page.onCallback = function(data) {
//  page.timingCallback = +new Date();
//  console.log('DOMContentLoaded');
//};

// Fired after onInitialized (usually, but not always)
page.onLoadStarted = function () {
  try {
    //console.log("# loadStart");
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

// Called just before the callback provided to page.open
page.onLoadFinished = function() {
  //console.log('page.onLoadFinished');
  page.timingOnLoadFinished = +new Date();
};

function createOutput() {
  //console.log('# done...');

  // Avoid transparent backgrounds
  page.evaluate(function() {
    if (document.body.bgColor == "")
       document.body.bgColor = 'white';
  });

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
  page.timingReadyState = page.evaluate(function () {
    return window.timingReadyState;
  });
  try {
    var startPoint = (page.timingInitialize > page.timingLoadStarted) ? page.timingLoadStarted : page.timingInitialize;
    var onContentReady = (page.timingDOMContentLoaded || page.timingReadyState['interactive']) - startPoint;
    var onLoad = (page.timingOnLoad || page.timingReadyState['complete'] || page.timingOnLoadFinished) - startPoint;
    var timings = {
      "onContentReady": ((onContentReady > 0) ? onContentReady : onLoad),
      "onLoad": onLoad,
      "duration": page.timingOnLoadFinished-startPoint
    };

    // FOR DEBUGGING TIMINGS
    //var prefix = sharedPrefix([""+page.timingInitialize, ""+page.timingLoadStarted])
    //prefix = prefix.substring(0, prefix.length-2)
    //offset = +rpad(prefix, (""+page.timingInitialize).length)
    //console.log('init     ' + (page.timingInitialize-offset))
    //console.log('start    ' + (page.timingLoadStarted-offset))
    //console.log('spoint   ' + (startPoint-offset))
    //console.log('content  ' + (page.timingDOMContentLoaded-offset))
    //console.log('interact ' + (page.timingReadyState['interactive']-offset))
    //console.log('load     ' + (page.timingOnLoad-offset))
    //console.log('complete ' + (page.timingReadyState['complete']-offset))
    //console.log('end      ' + (page.timingOnLoadFinished-offset))
    //console.log(json(timings))
    //console.log(json(page.timingReadyState))

    var har = createHAR(page, timings, status);

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

  } catch(err) {
    handleError(err);
  }

  phantom.exit();
}


function evaluateTestplan(status) {

    // We call waitFor here b/c in some cases it takes a few moments
    // for the page to fully load. Rather than exit right away, we'll
    // give it some time.
    // We call createOutput either way b/c this is not a fail condition.
    // Also pages that return a 401 response never set window.timingOnLoad.
    waitFor(function(){
      //console.log('# waiting...');
      return page.evaluate(function(){
        return window.document.readyState == 'complete';
      });
    }, createOutput, createOutput, 3000, 250);
}

try {
  page.open(page.address, evaluateTestplan);
} catch(err) {
  handleError(err);
}


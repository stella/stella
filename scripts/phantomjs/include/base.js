// BlameStella baseline

phantom.injectJs('include/sha1.js');
// https://github.com/sjkaliski/numbers.js

var page = require('webpage').create(),
    system = require('system'),
    fs = require('fs');


page.resources = [];
page.settings = {
  userAgent: 'Mozilla/5.0 (compatible; Stella/3.0; +https://blamestella.com/)',
  javascriptEnabled: true,
  loadImages: true,
  XSSAuditingEnabled: false,
  webSecurityEnabled: true
}
page.customHeaders = {
  //'X-Stella': 'https://www.blamestella.com/',
}

if (!Date.prototype.toISOString) {
  Date.prototype.toISOString = function () {
    function pad(n) { return n < 10 ? '0' + n : n; }
    function ms(n) { return n < 10 ? '00'+ n : n < 100 ? '0' + n : n }
    return this.getFullYear() + '-' +
      pad(this.getMonth() + 1) + '-' +
      pad(this.getDate()) + 'T' +
      pad(this.getHours()) + ':' +
      pad(this.getMinutes()) + ':' +
      pad(this.getSeconds()) + '.' +
      ms(this.getMilliseconds()) + 'Z';
  }
}

// Remove any duplicates in the array.
Array.prototype.getUnique = function(){
   var u = {}, a = [];
   for(var i = 0, l = this.length; i < l; ++i){
      if(this[i] in u)
         continue;
      a.push(this[i]);
      u[this[i]] = 1;
   }
   return a;
}

function parseURI(doc, uri) {
  var parser = document.createElement('a');
  parser.href = uri;
  return parser;
}

/**
 * Wait until the test condition is true or a timeout occurs. Useful for waiting
 * on a server response or for a ui change (fadeIn, etc.) to occur.
 *
 * @param testFx javascript condition that evaluates to a boolean,
 * it can be passed in as a string (e.g.: "1 == 1" or "$('#bar').is(':visible')" or
 * as a callback function.
 * @param onReady what to do when testFx condition is fulfilled,
 * it can be passed in as a string (e.g.: "1 == 1" or "$('#bar').is(':visible')" or
 * as a callback function.
 * @param onTimeout what to do when testFx condition is not fulfilled.
 * @param timeOutMillis the max amount of time to wait. If not specified, 3 sec is used.
 * @param repeatMillis the amount of time between intervals
 */
function waitFor(testFx, onReady, onTimeout, timeOutMillis, repeatMillis) {
  var maxtimeOutMillis = timeOutMillis ? timeOutMillis : 3000, //< Default Max Timout is 3s
    repeatMillis = repeatMillis ? repeatMillis : 1000,
    start = new Date().getTime(),
    condition = false,
    interval = setInterval(function() {
    if ( (new Date().getTime() - start < maxtimeOutMillis) && !condition ) {
      // If not time-out yet and condition not yet fulfilled
      condition = (typeof(testFx) === "string" ? eval(testFx) : testFx()); //< defensive code
    } else {
      if(!condition) { // If condition still not fulfilled (timeout but condition is 'false')
        console.log("# waitFor timeout ("+timeOutMillis/1000+"s)");
        typeof(onTimeout) === "string" ? eval(onTimeout) : onTimeout(); //< Do what it's supposed to do once the condition is NOT fulfilled
        clearInterval(interval); //< Stop this interval
      } else {         // Condition fulfilled (timeout and/or condition is 'true')
        var elapsed = (new Date().getTime() - start)
        typeof(onReady) === "string" ? eval(onReady) : onReady(); //< Do what it's supposed to do once the condition is fulfilled
        clearInterval(interval); //< Stop this interval
      }
    }
  }, 250); //< repeat check every 250ms
};

function hardTimeout(testFx, onTimeout, timeOutMillis) {
  var maxtimeOutMillis = timeOutMillis ? timeOutMillis : 20000,
    start = new Date().getTime(),
    condition = false,
    interval = setInterval(function() { // If not time-out yet and condition not yet fulfilled
    if ( (new Date().getTime() - start < maxtimeOutMillis) && !condition ) {
      condition = (typeof(testFx) === "string" ? eval(testFx) : testFx()); //< defensive code
    } else {
      var elapsed = (new Date().getTime() - start)
      if(!condition) { // If condition still not fulfilled (timeout but condition is 'false')
        onTimeout(elapsed);
      } else {
        clearInterval(interval); //< Stop this interval
      }
    }
  }, 1000); //< repeat check every 1000ms
}

/**
 * Render a given uri to a given file
 * @param uri URL to render
 * @param file File to render to
 * @param width Viewport width in pixels
 * @param height Viewport height in pixels
 * @param callback Callback function
 */
function renderUrlToFile(uri, file, width, height, callback) {
  var page = require('webpage').create();
  page.viewportSize = { width: width, height : height };
  page.settings.userAgent = "BlameStella.com renderbot";
  page.open(uri, function(status){
   if ( status !== "success") {
     console.log("Unable to render '"+uri+"' ");
     phantom.exit(1);
   } else {
     page.evaluate(function() {
       if (document.body.bgColor == "")
         document.body.bgColor = 'white';
     });
     page.render(file);
   }
   delete page;
   callback(uri, file);
  });
}

function normalize_uri(uri) {
  if (!uri.match(/^https?:\/\//))
    uri = "http://" + uri;
  return uri;
}

function createHAR(page, pageTimings, status) {
  return createHAR12(page, pageTimings, status);
}

// HTTP Archive v1.2 (http://www.softwareishard.com/blog/har-12-spec/)
function createHAR12(page, pageTimings, status) {
  var entries = [];
  var startTimeObj = new Date(page.timingInitialize);
  var endTimeObj = new Date(page.timingOnLoadFinished);

  page.resources.forEach(function (resource) {

    var request = resource.request,
        startReply = resource.startReply,
        endReply = resource.endReply;

    if (!request || (!startReply && !endReply)) {
      console.log("# skipping...");

    } else if (!startReply || !endReply) {
      var reply = startReply || endReply;

      entries.push({
        startedDateTime: request.time.toISOString(),
        time: -1,
        request: {
          method: request.method,
          url: request.url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: request.headers,
          queryString: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: reply.status,
          statusText: reply.statusText,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: reply.headers,
          redirectURL: "",
          headersSize: -1,
          bodySize: reply.bodySize,
          content: {
            size: reply.bodySize,
            mimeType: reply.contentType
          }
        },
        cache: {},
        timings: {}
      });
    } else {


      entries.push({
        startedDateTime: request.time.toISOString(),
        time: endReply.time - request.time,
        request: {
          method: request.method,
          url: request.url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: request.headers,
          queryString: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: endReply.status,
          statusText: endReply.statusText,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: endReply.headers,
          redirectURL: "",
          headersSize: -1,
          bodySize: startReply.bodySize,
          content: {
            size: startReply.bodySize,
            mimeType: endReply.contentType
          }
        },
        cache: {},
        timings: {
          blocked: 0,
          dns: -1,
          connect: -1,
          send: 0,
          wait: startReply.time - request.time,
          receive: endReply.time - startReply.time,
          ssl: -1
        }
      });
    }
  });

  return {
    log: {
      version: '1.2',
      creator: {
        name: "PhantomJS",
        version: phantom.version.major + '.' + phantom.version.minor + '.' + phantom.version.patch
      },
      status: status,
      viewPort: page.viewportSize,
      options: page.options,
      settings: page.settings,
      gaDisabled: page.gaDisabled,
      gaid: googleAnalyticsAccount(page.content),
      pages: [{
        startedDateTime: startTimeObj.toISOString(),
        endDateTime: endTimeObj.toISOString(),
        id: page.address,
        title: page.title,
        pageTimings: pageTimings || {}
      }],
      entries: entries
    }
  };
}

function googleAnalyticsAccount(str){
  var matches = str.toString().match(/ua\-\d{4,9}\-\d{1,4}/i);
  return matches == undefined ? null : matches[0];
}

function createErrorHAR(page, status, timeout) {
  var startTimeObj = new Date(page.timingLoadStarted);
  return {
    log: {
      version: '1.2',
      status: status,
      creator: {
        name: "PhantomJS",
        version: phantom.version.major + '.' + phantom.version.minor +
          '.' + phantom.version.patch
      },
      pages: [{
        startedDateTime: startTimeObj.toISOString(),
        id: page.address,
        title: '',
        pageTimings: { "onTimeout": timeout }
      }],
      entries: []
    }
  };
}

function handleError(err) {
  console.log(err)
  phantom.exit(1);
}

// via http://stackoverflow.com/questions/1916218/find-the-longest-common-starting-substring-in-a-set-of-strings
function sharedPrefix(A) {
  var tem1, tem2, s, A = A.slice(0).sort();
  tem1 = A[0];
  s = tem1.length;
  tem2 = A.pop();
  while(s && tem2.indexOf(tem1) == -1) {
    tem1 = tem1.substring(0, --s);
  }
  return tem1;
}

function rpad(number, length) {
  var str = '' + number;
  while (str.length < length) {
      str = str + '0';
  }
  return str;
}

function json(hsh) {
  return JSON.stringify(hsh, undefined, 0); // Indent: JSON.stringify(har, undefined, 1)
}

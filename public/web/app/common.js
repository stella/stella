// http://code.google.com/p/datejs/wiki/FormatSpecifiers
var timeStampFormat = 'MMM dd, yyyy h:mmtt';
var dateStampFormat = 'MMM dd, yyyy';
var newsStampFormat = 'ddd, MMM dd yyyy';
var timeStampDetailedFormat = 'MMM dd, yyyy h:mm:sstt';
var timelineHourlyStampFormat = 'h:mmtt';
var timelineDailyStampFormat = 'MMM-dd htt';
var timeOfDayFormat = 'h:mmtt';

// Font Replacement
Cufon.replace('.cufon');
Cufon.replace('#productHook', { fontFamily: 'Officina Book Italic' })

// See: http://stackoverflow.com/questions/10013812/how-to-prevent-jquery-ajax-from-following-a-redirect-after-a-post
jQuery.ajaxSetup({
  beforeSend: function(xhr) {
    xhr.setRequestHeader("ACCEPT", "text/javascript")
    xhr.setRequestHeader("X_REQUESTED_WITH", "xmlhttprequest")
  }
})

var is_chrome = navigator.userAgent.toLowerCase().indexOf('chrome') > -1;
function log(msg) {
  if (is_chrome)
    console.log(msg)
}

/*
 * JavaScript Pretty Date
 * Copyright (c) 2008 John Resig (jquery.com)
 * Licensed under the MIT license.
 */

// Takes an epoch time in milliseconds and returns a string representing how
// long ago the date represents.
function prettyDate(time){
  var date = new Date(parseInt(time)),
    diff = (((new Date()).getTime() - date.getTime()) / 1000),
    day_diff = Math.floor(diff / 86400);

  if ( isNaN(day_diff) || day_diff < 0 || day_diff >= 31 )
    return;

  return day_diff == 0 && (
      diff < 60 && "just now" ||
      diff < 120 && "1 minute ago" ||
      diff < 3600 && Math.floor( diff / 60 ) + " minutes ago" ||
      diff < 7200 && "1 hour ago" ||
      diff < 86400 && Math.floor( diff / 3600 ) + " hours ago") ||
    day_diff == 1 && "Yesterday" ||
    day_diff < 14 && day_diff + " days ago" ||
    day_diff < 31 && Math.ceil( day_diff / 7 ) + " weeks ago";
}

function newsDate(time) {
  var date = new Date(parseInt(time*1000))
  date.setYear(date.getFullYear() - 113)
  var now = date.toString(newsStampFormat)
  return now;
}

function req(meth, uri, params, onSuccess, onFailure) {
  $.ajax({
    type: meth,
    url: uri,
    data: params,
    success: onSuccess,
    error: onFailure
  });
  return false;
}

function postAndRefresh(e) {
  var obj = $(this);
  $.ajax({
    type: 'POST',
    url: obj.attr('href'),
    data: {'shrimp': shrimp},
    success: function(data, textStatus){
      //log(data)
      window.location.reload()
    },
    error: function(){
      alertify.error("Ooops! There was an error.")
    }
  });
  return e.preventDefault();
};

function postAndRedirect(e) {
  var obj = $(this);
  log(obj.attr('href'))
  $.ajax({
    type: 'POST',
    url: obj.attr('href'),
    data: {'shrimp': shrimp},
    success: function(data, textStatus){
      window.location = '/';
    },
    error: function(){
      alertify.error("Ooops! There was an error.")
    }
  });
  return e.preventDefault();
};

function checkPostAndRefresh(e) {
  var obj = $(this);
  $.ajax({
    type: 'POST',
    url: obj.attr('href'),
    data: {'shrimp': shrimp},
    success: function(data, textStatus){
      //log(data)
      window.location.reload()
    },
    error: function(){
      alertify.error("Ooops! There was an error.")
    }
  });
};

function postAndIgnore(e) {
  var obj = $(this);
  $.ajax({
    type: 'POST',
    url: obj.attr('href'),
    data: {'shrimp': shrimp},
    success: function(data, textStatus){
      //alertify.log("Updated")
      window.location.reload()
    },
    error: function(){
      alertify.error("Ooops! There was an error.")
    }
  });
  return e.preventDefault();
};

function postAndDelete(e) {
  var obj = $(this);
  $.ajax({
    type: 'POST',
    url: obj.attr('href'),
    data: {'shrimp': shrimp},
    success: function(data, textStatus){
      alertify.success("Done.")
      $('#object-' + obj.data('objid')).remove();
    },
    error: function(){
      alertify.error("Ooops! There was an error.")
    }
  });
  return e.preventDefault();
};

function hostHide(e) {
  var obj = $(this);
  var target = obj.parent().parent();
  $.ajax({
    type: 'POST',
    url: obj.attr('href'),
    data: {'shrimp': shrimp},
    success: function(data, textStatus){
      target.hide();
      return false;
    },
    error: function(){
      alertify.error("Ooops! There was an error.")
    }
  });
  return e.preventDefault();
};

function ignoreAction(e) {
  return e.preventDefault();
}

function hostShow(e) {
  var obj = $(this);
  var target = obj.parent().parent();
  $.ajax({
    type: 'POST',
    url: obj.attr('href'),
    data: {'shrimp': shrimp},
    success: function(data, textStatus){
      // TODO: update ui
      return false;
    },
    error: function(){
      alertify.error("Ooops! There was an error.")
    }
  });
  return e.preventDefault();
};

 // COMMON FUNCTIONS
$(function() {
  $.fn.clearDefault = function(){
    return this.each(function(){
      var default_value = $(this).val();
      $(this).focus(function(){
        if ($(this).val() == default_value) $(this).val("");
      });
      $(this).blur(function(){
        if ($(this).val() == "") $(this).val(default_value);
      });
    });
  };

  $.fn.prettyDate = function(){
    return this.each(function(){
      var date = prettyDate(this.title*1000);
      if ( date ) {
        jQuery(this).text( date );
        if ( $(this).hasClass("cufon") )
          Cufon.replace(this);
      }
    });
  };

  $.fn.currentTime = function(){
    return this.each(function(){
      var now = new Date().toString(timeStampFormat)
      if (now && now != jQuery(this).text()) {
        jQuery(this).text( now );
        if ( $(this).hasClass("cufon") )
          Cufon.replace(this);
      }
    });
  };

  $.fn.timeStampDetailed = function(){
    return this.each(function(){
      var date = new Date(parseInt(this.title*1000))
      var now = date.toString(timeStampDetailedFormat)
      if (now && now != jQuery(this).text()) {
        jQuery(this).text( now );
        if ( $(this).hasClass("cufon") )
          Cufon.replace(this);
      }
    });
  };

  $.fn.timeStamp = function(){
    return this.each(function(){
      var date = new Date(parseInt(this.title*1000))
      var now = date.toString(timeStampFormat)
      if (now && now != jQuery(this).text()) {
        jQuery(this).text( now );
        if ( $(this).hasClass("cufon") )
          Cufon.replace(this);
      }
    });
  };

  $.fn.dateStamp = function(){
    return this.each(function(){
      var date = new Date(parseInt(this.title*1000))
      var now = date.toString(dateStampFormat)
      if (now && now != jQuery(this).text()) {
        jQuery(this).text( now );
        if ( $(this).hasClass("cufon") )
          Cufon.replace(this);
      }
    });
  };

  $.fn.timeOfDay = function(){
    return this.each(function(){
      var date = new Date(parseInt(this.title*1000))
      var now = date.toString(timeOfDayFormat)
      if (now && now != jQuery(this).text()) {
        jQuery(this).text( now.toLowerCase() );
        if ( $(this).hasClass("cufon") )
          Cufon.replace(this);
      }
    });
  };



  $.fn.mustache = function (data, partial, stream) {
    var content = Mustache.to_html(this.html(), data, partial, stream)
    this.replaceWith(content);
    $(this)
  };

  $.fn.hilite = function(){$(this).fadeOut(100);$(this).fadeIn(500)};
  $.fn.hiliteSlow = function(){$(this).fadeOut(500);$(this).fadeIn(1000)};

});


function genericError() {
  alertify.error("Ooops! There was an error.");
}

// COMMON BEHAVIORS
$(function() {

  $('[placeholder]').focus(function() {
    var input = $(this);
    if (input.val() == input.attr('placeholder')) {
      input.val('');
      input.removeClass('placeholder');
    }
  }).blur();

  $(".prettyDate").prettyDate();
  $(".currentTime").currentTime();

  setInterval(function(){
    $(".prettyDate").prettyDate();
    $(".currentTime").currentTime();
  }, 5000);

  $(".tsdetailed").timeStampDetailed();
  $(".tsbasic").timeStamp();
  $(".dateStamp").dateStamp();
  $(".timeOfDay").timeOfDay();

  $('input.clearDefault').clearDefault();

  $('.plan-hide').click(hostHide);
  $('.plan-enable').click(postAndRefresh);
  $('.plan-disable').click(postAndRefresh);


  $('.btn-ignore').click(ignoreAction);

  $('.host-notify').click(postAndIgnore);
  $('.host-hide').click(hostHide);
  $('.host-show').click(hostShow);
  $('.host-start').click(postAndRefresh);
  $('.host-upgrade').click(postAndRefresh);
  $('.host-stop').click(postAndRefresh);
  $('.host-destroy').click(postAndRedirect);
  $('.contact-delete').click(postAndDelete);

  $('.checkupSummaryToggle').click(function() {
    $("#checkupSummary").slideToggle();
    $('.checkupSummaryToggle').toggle();
    return false;
  });
  $(".send-test-sms").click(function(e) {
    var obj = $(this);
    $.ajax({
      type: 'POST',
      url: obj.attr('href'),
      success: function(data, textStatus){
        alertify.log("SMS message sent");
      },
      error: function(){
        alertify.error("Ooops! There was an error.");
      }
    });
    return e.preventDefault();

  });
  $('#toggle-signin').click(function(){
    $('#nav-hideable').hide();
    $('#form-signin').fadeIn(200);
    $('#form-signin').removeClass('hidden');
    $('#input-email').focus();
    $(document).keyup(function(e) {
      //if (e.keyCode == 13) { $('.save').click(); }     // enter
      if (e.keyCode == 27) {
        $('#form-signin').hide();
        $('#nav-hideable').fadeIn(200);
      }   // esc
    });
    return false;
  });
  $(".selectable").click(function(){
    this.select();
  });

  $('.rt').tooltip({

  });

  $('.rt-summary-header').popover({
    placement: 'bottom',
    title: "About this response time",
    content: "All of our data is generated with real browsers (Webkit). The number of the left is amount of time until the content is loaded (i.e. DOMContentLoaded). The number on the right is the time for the page to be available to the user."
  });

  $('#pageTabs a').click(function (e) {
    e.preventDefault();
    $(this).tab('show');
  })
});


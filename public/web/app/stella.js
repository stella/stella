var global;

function req(meth, uri, params, onSuccess) {
  $.ajax({
    type: meth,
    url: uri,
    data: params,
    success: onSuccess,
    error: function(e){
      global = e;
      alert("Request failed (status: " + e.status + ")")
    }
  });
  return false;
}

function handleIncidentCommentAction(that, e, handler) {
  try {
    var incidentRow = $(that).parents('tr:first');
    var commentRow = $(that).parents('li:first');
    var runId = incidentRow[0].id.split('_')[1];
    var convoId = commentRow[0].id.split('_')[1];
    var shrimp = $("#addCommentPrompt form input[name=shrimp]").val();
    handler(commentRow, shrimp, runId, convoId);
    return e.preventDefault();
  } catch (err) {
    log(err)
  }
}

function handleHostAction(that, e, handler) {
  try {
    var domObj = $(that).parents('div:first');
    var el = domObj[0].id.split('_');
    var hostid = el[1]
    var subdomid = el[2]
    var shrimp = $('body').attr("data-shrimp")
    log(hostid)
    log(subdomid)
    handler(domObj, shrimp, hostid, subdomid);
    return e.preventDefault();
  } catch (err) {
    log(err)
  }
}

var is_chrome = navigator.userAgent.toLowerCase().indexOf('chrome') > -1;
function log(msg) {
  if (is_chrome)
    console.log(msg)
}


function addIncidentComment(shrimp, runId, comment, onSuccess){
  req('POST', '/incident/comment/', {shrimp: shrimp, runid: runId, comment: comment}, onSuccess);
}

function deleteIncidentComment(shrimp, runId, convoId, onSuccess){
  req('POST', '/incident/comment/delete', {shrimp: shrimp, runid: runId, convoid: convoId}, onSuccess);
}

function deleteHostSubdomain(shrimp, hostid, subdomid, onSuccess){
  req('POST', '/host/subdomain/destroy', {shrimp: shrimp, hostid: hostid, subdomid: subdomid}, onSuccess);
}


function createLongSparkline(objId, meanValues, sdValues) {

    $(objId).sparkline(meanValues, 
    { 
      type: 'bar',
      composite: true,  
      barColor: '#ccc',
      zeroColor: '#ff6666',
      nullColor: '#ff6666',
      barWidth: 2,
      barSpacing: 1.2,
      height: '40px'

    });
}

function createShortSparkline(objId, meanValues, sdValues) {
    
    $(objId).sparkline(meanValues, 
    {
      type: 'line', 
      composite: true,
      lineColor: '#999', 
      fillColor: '#ccc',
      spotRadius: 0,
      lineWidth: 1,
      height: '40px',
      width: '260px'
    });

    //$(objId).sparkline(meanValues, 
    //{ 
    //  type: 'bar',
    //  composite: true,  
    //  barColor: 'red',
    //  barWidth: 1,
    //  barSpacing: 0.5
    //});
}


function createTinySparkline(objId, meanValues, sdValues) {
    
    $(objId).sparkline(meanValues, 
    {
      type: 'line', 
      lineColor: '#ccc', 
      fillColor: '#e8e8e8',
      spotRadius: 0,
      lineWidth: 1
    });

    $(objId).sparkline(sdValues, 
    { 
      type: 'bar',
      composite: true,  
      barColor: '#666',
      zeroColor: '#fff',
      nullColor: 'blue',
      barWidth: 2,
      barSpacing: 1
    });
}

	


$(function() {
  $('.hiddenHelpLink').click(function(){
    $('.hiddenHelpBox').animate({"height": "toggle"}, { duration: 500 })
    return false;
  });
});

$(function() {
  $('.toggleIncidentComments').click(function(){
    if ($(this).text().indexOf('Hide')) {
      $(this).val($(this).text())
      $(this).text("Hide comments")
    } else {
      $(this).text($(this).val())
    }
    var row = $(this).parents('tr:first');
    var itemId = row[0].id.split('_')[1];
    $('#incidentComments_' + itemId).animate({"height": "toggle"}, { duration: 500 })
    return false;
  });
});


$(function() {
  $('.checkupRedirectTry').click(function() {
    old_uri = $('#uri').val()
    new_uri = $('.checkupRedirectTry').text()
    $('#uri').val(new_uri)
    $('#request button').hilite();
    $('#request button').text('Run Checkup');
    Cufon.replace('#request button', {
      textTransform: 'uppercase',
      textShadow: '0px 1px #006666'
    });
    return false;
    });
});


  
  
$(function() {
  $('.switch').iphoneStyle({
    checkedLabel: 'ENABLED',
    uncheckedLabel: 'DISABLED'
    }).change(updatePlanMonitor);
});


function updatePlanMonitor() {
  var thisObj = this
  var enable = thisObj.checked
  var form = $(thisObj).parents('form:first');
  var formObj = form.get(0);
  var shrimp = $("input[name='shrimp']", form).val();
  var toggle = $("input[name='switch']", form).val();
  $.ajax({
    type: "POST",
    url: formObj.action,
    data: { 'enable': enable, 'shrimp': shrimp },
    success: function() {
      // Don't reload; it's jarring.
      //window.location.reload();
    },
    error: function() {
      alert("We're very popular right now! Please try again later :[")
      return false;
    }
  });
  return false;
}


(function($){
  $.fn.clearDefaultInput = function(){
    return this.each(function(){
      var default_value = $(this).val();
      $(this).focus(function(){
        if ($(this).val() == default_value) $(this).val("").removeClass('defaultContent');
      });
      $(this).blur(function(){
        if ($(this).val() == "") $(this).val(default_value).addClass('defaultContent');
      });
    });
  };
  
})(jQuery);
 

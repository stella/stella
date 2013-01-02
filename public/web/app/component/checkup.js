

var maxChecks = 30;
var prevStatus = 'new'
function checkCheckupStatus(checkid) {
  if (maxChecks < 0)
    return;
  maxChecks -= 1;
  try {
    var statusURI = "/checkup/" + checkid + "/status";
    $.getJSON(statusURI, { field: 'status' }, function(res) {
      if (res.status == "done" || res.status == "fubar") {
        location.reload();
      } else if (res.status != prevStatus) {
        prevStatus = res.status;
        $('#statusStr').text(res.status);
      }
    });
  } catch(ex) {
    // ignore
    log(ex)
  }
}

$.fn.progressDots = function(){
  return this.each(function(){
    var text = jQuery(this).text();
    var spos = text.indexOf('.');
    var epos = text.lastIndexOf('.');
    if (epos-spos < 2) {
      text = jQuery(this).text( text + '.' );
    } else {
      text = jQuery(this).text( text.substring(0, spos) );
    }
  }); 
};

$(function() {
  //$("#checkupResults").tabs();
  
  $('#request button').click(function(e) {
    $("#request").hide();
    $("#form-signup").show();
    $('#signup-email').focus();
    $(document).keyup(function(e) {
      if (e.keyCode == 27) { 
        $('#form-signup').hide();
        $('#request').fadeIn(200);
      }   // esc
    });
    e.preventDefault();
  });

  //$('#checkupMonitor button').click(function(e) {
  //  $("#checkupMonitor").hide();
  //  $("#request").show();
  //  e.preventDefault();
  //});
  
});
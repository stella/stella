
$(function() {
  $(".prettyDate").prettyDate();
  $(".currentTime").currentTime();
  $(".timeStampDetailed").timeStampDetailed();
  $(".timeStamp").timeStamp();
  $(".dateStamp").dateStamp();
  $(".timeOfDay").timeOfDay();
  
  $('input.clearDefault').clearDefault();
  
  setInterval(function(){ 
    $(".prettyDate").prettyDate();
    $(".currentTime").currentTime(); 
  }, 5000);  
  
  $('.err').click( function() {
    playSound("/r/stella.mp3");
  });  
  
  $(".titleTooltip[title]").tooltip({tipClass: 'smallDarkTooltip', position: 'top center'});
  
  $(".incidentComments .delete").click(function(e){
    return handleIncidentCommentAction(this, e, function(commentRow, shrimp, runId, convoId){
      deleteIncidentComment(shrimp, runId, convoId, function() {
        $(commentRow).remove(); //Remove the row containing the image element
      });
    });
  });
  
  $(".hostSubdomain .delete").click(function(e){
    return handleHostAction(this, e, function(itemRow, shrimp, hostid, subdomid){
      deleteHostSubdomain(shrimp, hostid, subdomid, function() {
        //$(itemRow).remove(); //Remove the row containing the image element
        window.location.reload();
      });
    });
  });
  
  var modalDialogs = $(".addComment").overlay({
    mask: {
      color: 'azure',
      loadSpeed: 100,
      opacity: 0.5
    },
    closeOnEsc: true,
    closeOnClick: true, 
    onBeforeLoad: function() {
      var title = this.getTrigger().attr('title');
      var row = $(this.getTrigger()).parents('tr:first');
      var itemId = row[0].id.split('_')[1];
      $('#addCommentPrompt .incidentTitle').text(title)
      $('#addCommentPrompt .incidentId').val(itemId)
    }
  });
  
  
  $("#addCommentPrompt form").submit(function(e) {
    try {
      // close the overlay
      modalDialogs.eq(0).overlay().close();

      // get user input
      var shrimp = $("input[name=shrimp]", this).val();
      var runId = $("input[name=runid]", this).val();
      var comment = $("textarea[name=comment]", this).val();

      // do something with the answer
      addIncidentComment(shrimp, runId, comment, function(){
        window.location.reload();
      });
      
    } catch (err) {
      log(err);
    }
    // do not submit the form
    return e.preventDefault();
  });
  
});



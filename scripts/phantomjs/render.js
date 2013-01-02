// BlameStella Render to PNG
// 2012-05-03
// 
// Usage: bin/phantomjs scripts/phantomjs/render.js URI [WIDTH] [HEIGHT]

phantom.injectJs('include/base.js');

if (system.args.length < 2) {
  console.log('Usage: phantomjs scripts/phantomjs/render.js <URI> [WIDTH] [HEIGHT]');
  phantom.exit();
}

var uri = normalize_uri(system.args[1]),
    width = system.args[2] || 1024,
    height = system.args[3] || 768;

var dir = '/tmp';

try {
  
  var fileid = hex_sha1(uri + width + height + new Date().toISOString());
  var file_name = fs.absolute(dir + '/' + fileid + ".png");
  
  if (!fs.isWritable(dir)) {
    console.log("Cannot write to: " + dir)
    phantom.exit(1);
  }
  
  renderUrlToFile(uri, file_name, width, height, function(uri, file){
    if (fs.isReadable(file)) {
      console.log(file);
      phantom.exit();
    } else {
      phantom.exit(1);
    }
  });

} catch(err) {
  console.log(err)
  phantom.exit(1);
}

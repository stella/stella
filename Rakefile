require "rubygems"
require "rake"
require "rake/clean"
require 'yaml'

require 'rdoc/task'

config = YAML.load_file("BUILD.yml")
task :default => ["build"]
CLEAN.include [ 'pkg', 'rdoc' ]
name = "stella"

begin
  require "jeweler"
  Jeweler::Tasks.new do |gem|
    gem.version = "#{config[:MAJOR]}.#{config[:MINOR]}.#{config[:PATCH]}"
    gem.name = name
    gem.rubyforge_project = gem.name
    gem.summary = "The future of web monitoring."
    gem.description = "The future of web monitoring"
    gem.email = "delano@blamestella.com"
    gem.homepage = "http://github.com/stella/stella"
    gem.authors = ["Delano Mandelbaum"]
    gem.add_dependency('bundler',        '>= 1.2.1')
  end
  Jeweler::GemcutterTasks.new
rescue LoadError
  puts "Jeweler (or a dependency) not available. Install it with: sudo gem install jeweler"
end

RDoc::Task.new do |rdoc|
  version = "#{config[:MAJOR]}.#{config[:MINOR]}.#{config[:PATCH]}"
  rdoc.rdoc_dir = "rdoc"
  rdoc.title = "#{name} #{version}"
  rdoc.rdoc_files.include("README*")
  rdoc.rdoc_files.include("LICENSE.txt")
  rdoc.rdoc_files.include("bin/*.rb")
  rdoc.rdoc_files.include("lib/**/*.rb")
end


# Rackup - BlameStella
# 2012-04-11
#
# Usage:
#
#        bundle install
#        bundle exec thin -R config.ru -e dev start
#        open http://localhost:3000/
#

ENV['APP_ROOT'] = ::File.expand_path(::File.join(::File.dirname(__FILE__)))
$:.unshift(::File.join(ENV['APP_ROOT'], 'app'))
$:.unshift(::File.join(ENV['APP_ROOT'], 'lib'))

PUBLIC_DIR = "#{ENV['APP_ROOT']}/public/web"
APP_DIR = "#{ENV['APP_ROOT']}/lib/stella/app"

require 'otto'

require 'stella'
require 'stella/app/web'
require 'stella/app/api'
require 'stella/app/colonel'

apps = {
  '/'         => Otto.new("#{APP_DIR}/web/routes"),
  '/api'      => Otto.new("#{APP_DIR}/api/routes"),
  '/colonel'  => Otto.new("#{APP_DIR}/colonel/routes"),
}

# FROM: http://www.padrinorb.com/guides/adding-new-components
#LESS_INIT = (<<-LESS).gsub(/^ {6}/, '')
#require 'rack/less'
#Rack::Less.configure do |config|
#  config.compress = true
#end
#app.use Rack::Less, :root => app.root, :source  => 'stylesheets/',
#                    :public    => 'public/', :hosted_at => '/stylesheets'
#LESS
#
#def setup_stylesheet
#  require_dependencies 'less', 'rack-less'
#  initializer :less, LESS_INIT
#  empty_directory destination_root('/app/stylesheets')
#end

#Stella.debug = true

# DEV: Run web apps with extra logging and reloading
if Otto.env?(:dev)
  Stella.load! :app
  apps.each_pair do |path,app|
    map(path) {
      use Rack::CommonLogger
      use Rack::Reloader, 1.second
      app.option[:public] = PUBLIC_DIR
      app.add_static_path '/favicon.ico'
      run app
    }
  end
  map("/app/")      { run Rack::File.new("#{PUBLIC_DIR}/app") }
  map("/etc/")      { run Rack::File.new("#{PUBLIC_DIR}/etc") }
  map("/img/")      { run Rack::File.new("#{PUBLIC_DIR}/img") }
  map("/t/")        { run Rack::File.new(Stella.config['render.path']) }

# PROD: run barebones webapps
else
  Stella.load! :app
  apps.each_pair do |path,app|
    map(path) { use Rack::CommonLogger; run app }
  end
  #$SAFE = 1  # http://www.rubycentral.com/pickaxe/taint.html
end

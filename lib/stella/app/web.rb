require 'stella'  # must be required before
require 'stella/email'
require 'stella/app/web/base'
require 'stella/app/web/views'
require 'timeout'

class Stella
  class App
    autoload :Homepage, 'stella/app/web/homepage'
    autoload :Account, 'stella/app/web/account'
    autoload :Machine, 'stella/app/web/machine'
    autoload :Checkup, 'stella/app/web/checkup'
    autoload :Host, 'stella/app/web/host'
    autoload :Info, 'stella/app/web/info'
    autoload :Docs, 'stella/app/web/docs'
  end
end


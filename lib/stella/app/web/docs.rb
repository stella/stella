require 'coderay'

Stella::Logic::ViewDocs.docdir = File.join(File.dirname(__FILE__), 'docs')


class Stella::App::Docs
  include Stella::App::Base

  def index
    publically do
      logic = Stella::Logic::ViewDocs.new(sess, cust, req.params)
      view = Stella::App::Views::Docs.new req, sess, cust
      @cacheonce ||= {}
      if @cacheonce[logic.topic].nil? || Otto.env?(:dev)
        Stella.li "Reloading docs for: #{logic.topic}"
        @cacheonce[logic.topic] = logic.documentation
        if @cacheonce[logic.topic] && @cacheonce[logic.topic][:endpoints]
          @cacheonce[logic.topic][:endpoints].each do |endpoint|
            next unless endpoint
            endpoint[:has_params] = endpoint[:params] && !endpoint[:params].empty?
            if endpoint[:example]
              endpoint[:example] = CodeRay.scan(endpoint[:example], :json).html
            end
          end
        end
      end
      view.topic, view.docs = logic.topic, @cacheonce[logic.topic]
      res.body = view.render
    end
  end
  alias_method :topic, :index

end


module Stella::App::Views
  class Docs < Stella::App::View
    attr_accessor :docs, :topic
    def init *args
      @body_class = 'docs'
      @title, @title_subtext = 'API Docs', 'Stella Developers'
      @css << '/app/style/component/docs.css'
      @css << '/etc/highlight/colourize.css'
      #@tucker[:feedback_form_text] = 'Ask Tucker about the API!'
      #@tucker[:feedback_button_text] = 'Deliver it'
      self[:api_custid] = authenticated ? cust.email : 'CUSTID'
      self[:api_key] = authenticated ? cust.apikey : 'APIKEY'
    end
    # These links appear at the side of the docs
    def docnav
      links = [
        ahref('/docs/api/overview', 'Overview', topic?(:overview) ? 'selected' : ''),
        ahref('/docs/api/authentication', 'Authentication', topic?(:authentication) ? 'selected' : ''),
        ahref('/docs/api/checkup',  'Checkups', topic?(:checkup) ? 'selected' : ''),
        ahref('/docs/api/monitor',  'Monitors', topic?(:monitor) ? 'selected' : ''),
        #ahref('/docs/api/customer', 'Customers', topic?(:customer) ? 'selected' : ''),
        #ahref('/docs/api/host',  'Hosts', topic?(:host) ? 'selected' : ''),
        #ahref('/docs/api/global',  'Global Data', topic?(:global) ? 'selected' : ''),
        #ahref('/docs/api/testplan', 'Testplans', topic?(:testplan) ? 'selected' : ''),
        #ahref('/docs/api/vendor',  'Vendors', topic?(:vendor) ? 'selected' : ''),
      ]
      links
    end

    def topic?(guess)
      @topic.to_s == guess.to_s
    end

  end
end






__END__


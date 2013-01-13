
class Stella
  class App
    module Views
      class JSTemplate < Mustache
        self.template_path = './templates/web/partial'
        def self.load
          @templates = Hash.new {|hash,key| hash[key.to_s] if Symbol === key }
          Dir.glob(File.join(template_path, '*')).each do |path|
            #Stella.ld " partialsrc: #{path}"
            name = File.basename path, '.mustache'
            @templates[name.to_sym] = partial(name)  # Mustache.partial
          end
          @templates
        end
      end
    end
    class View < Mustache
      require 'stella/app/web/views/helpers'
      self.template_path = './templates/web'
      self.view_namespace = Stella::App::Views
      self.view_path = './app/stella/views'
      attr_reader :js, :css, :description, :keywords, :config, :params
      attr_reader :topnav, :tucker, :morton, :jsvars, :messages
      attr_reader :body_class, :gravatar_uri, :signup_incomplete, :authenticated
      attr_reader :spreedly_signup_uri, :spreedly_subscription_uri, :product
      attr_accessor :req, :sess, :cust, :msg, :err
      attr_accessor :title, :title_subtext, :show_feedback_form, :with_navbar
      def initialize req=nil, sessobj=nil, custobj=nil, *args
        @req, @sess, @cust = req, sessobj, custobj
        @messages = { :info => [], :error => [] }
        @title, @title_subtext = 'Is your site fast?', 'Stella'
        @js, @css, @jsvars = [], [], []
        @description = 'Introducing Stella. Is your site fast?'
        @keywords = 'stella,uptime,api,developer,monitoring,performance,testing,tucker,ruby,web application,webapp'
        @cust ||= Stella::Customer.anonymous
        #@sess ||= Stella::Session.new
        begin
          # We need to rescue this in the case that redis is down.
          @params = @sess.request_params!
          @params ||= {}
          @authenticated = @sess.authenticated?
        rescue => ex
          Stella.ld ex.message
          Stella.ld ex.backtrace
        end
        @show_feedback_form = true
        @body_class = :common
        @with_navbar = true
        @gravatar_uri = gravatar(@cust.email) if !@cust.email.to_s.empty?
        @topnav = []
        if authenticated
          self[:your_sites] = cust.hosts(:hidden => false, :order => [ :monitored.desc, :updated_at.desc ])
          self[:your_sites].sort! { |a,b|
            b.rangemetrics.past_1h['on_load_avg'].to_i <=> a.rangemetrics.past_1h['on_load_avg'].to_i
          }
          self[:your_sites_count] = self[:your_sites].size
          self[:your_monitored_count] = self[:your_sites].select { |h| h.monitored }.size
          self[:has_sites] = ! self[:your_sites_count].zero?
          self[:active_products] = cust.active_products
          self[:monthly_bill] = cust.monthly_bill
          #self[:daily_bill] = Stella::DailyUsage.usage_per_day(cust.monthly_bill)
        else
          #@topnav << ahref('/info/company', 'How it Works')
          @topnav << ahref('/signup', 'Signup', 'highlight')
          @topnav << ahref('http://blog.blamestella.com', 'Blog')
          @topnav << ahref('/docs', 'API')
          @topnav << ahref('/info/company', 'About Us')
        end
        self[:stella_version] = self.class.stella_version
        self[:hello_style] = :simple_hello
        self[:colonels_only] = cust.colonel?
        self[:is_production] =  ['production', 'prod'].member?(Stella.config['site.env'])
        self[:spreedlycore_key] = Stella.config['vendor.spreedlycore.key']
        self[:site_price] = 2
        init(*args) if respond_to?(:init)
        if Stella.config
          # whitelist config values for template use.
          @config = {}
          %w[site.host site.scheme site.port].each do |k|
            @config[k.tr('.', '_')] = Stella.config[k]
          end
          jsvars << jsvar(:shrimp, sess.add_shrimp) if sess
          jsvars << jsvar(:custid, cust.custid)
          jsvars << jsvar(:email, cust.email)
        end
        self[:is_local] = local?
      end
      def add_message msg
        messages[:info] << msg unless msg.to_s.empty?
      end
      def add_error msg
        messages[:error] << msg unless msg.to_s.empty?
      end
      def add_form_fields hsh
        (self.form_fields ||= {}).merge! hsh unless hsh.nil?
      end
      def messages
        if sess
          @messages[:info].push *sess.info_messages!
          @messages[:error].push *sess.error_messages!
        end
        @messages
      #rescue => ex
      #  @messages
      end
      def partialsrc
        self.class.partialsrc
      end
      def self.partialsrc
        if @partialsrc.nil? || Otto.env?(:dev)
          @partialsrc = Stella::App::Views::JSTemplate.load
        end
        @partialsrc
      end
      def self.stella_version
        @stella_version ||= Stella::VERSION.gibbler.short
      end
      include Stella::App::Views::Helpers::Common
      include Stella::App::Views::Helpers::URIHelpers
      include Stella::App::Views::Helpers::ThirdParty
      include Stella::App::Views::Helpers::DateTime
    end

    # Note some of the methods here may not work in a static context.
    # In that case, you can set the request and response objects.
    module StaticHelpers
      extend Stella::App::Views::Helpers::Common
      extend Stella::App::Views::Helpers::URIHelpers
      extend Stella::App::Views::Helpers::ThirdParty
      extend Stella::App::Views::Helpers::DateTime
      class << self
        attr_accessor :req, :res
      end
    end




  end
end

__END__
class Stella

  class App

    class Root
      include Base

      def info
        publically do
          view = Stella::App::Views::Info.new req, sess, cust
          res.body = view.render
        end
      end

      def about
        res.redirect '/info/company'
      end

      def dashboard
        privately do
          authenticated!
          view = Stella::App::Views::Dashboard.new req, sess, cust
          res.body = view.render
        end
      end

      def error
        publically do
          res.status = 500
          view = Stella::App::Views::Error.new req, sess, cust
          res.body = view.render
        end
      end

      def not_found
        publically do
          view = Stella::App::Views::NotFound.new req, sess, cust
          res.body = view.render
        end
      end

      def server_error
        res.status = 500
        view = Stella::App::Views::Error.new req, sess, cust
        res.body = view.render
      end
    end

    class Account
      include Base


      def pdtest
        privately('/account') do
          logic = BS::Logic::VerifyPagerDuty.new @sess, @cust, req.params
          logic.raise_concerns
          logic.send_test_notification
          res.redirect '/account'
        end
      end

      def smstest
        privately('/account') do
          logic = BS::Logic::VerifySMS.new @sess, @cust, req.params
          logic.raise_concerns
          logic.send_test_sms
          res.redirect '/account'
        end
      end

      def spreedly_subscribe_redirect
        privately('/account') do
          prodid = req.params[:prodid] || cust.prodid
          plan = BS::Product.plan(prodid)
          raise Stella::App::Problem, "No such plan: #{prodid}" if plan.nil?
          if cust.srcpartner?(:paypal)
            uri = '/account/paypal'
            BS.info "Redirect to paypal payment page"
          else
            uri = plan.spreedly_signup_uri(cust)
            BS.info "Redirecting to Spreedly subscription page for #{prodid}"
          end
          BS.info uri
          res.redirect uri
        end
      end

      def spreedly_refresh_info
        privately('/account') do
          if cust.srcpartner?(:organic)
            BS.info "Refreshing account info for #{cust.custid}"
            cust.spreedly.update_data
          else
            BS.info "Nothing to refresh for #{cust.custid}: #{cust.srcpartner}"
          end
          # DISABLED THIS SHIT ON JUNE 30, 2011. Where is it used?
          #if req.params[:refresh]
          #  cust.prodid = :free
          #  cust.save
          #end
          res.redirect '/account'
        end
      end

      # a hook for spreedly to send data back to stella periodically
      def spreedly_update
        @ignoreshrimp = true
        publically do
          if req.post?
            subscriber_ids = (req.params[:subscriber_ids] || '').split(/\,\s?/)
            BS.info "[spreedly-update] #{req.params.to_json}"
            subscriber_ids.each do |external_id|
              thiscust = Customer.external_ids[external_id]
              if Customer === thiscust
                BS.info " updating data for #{external_id} (#{thiscust.custid})"
                thiscust.spreedly.update_data
              else
                BS.info " skipping #{external_id}"
              end
            end
            res.body = "That's #{subscriber_ids.size} IDs. Thank you spreedly!\n" # need to return a string
          end
        end

      end

      private

    end

    #require 'stella/views'
    #require 'stella/docs'
    #require 'stella/checkup'
  end

end

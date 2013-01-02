require 'dm-serializer'

class Stella::App::Homepage
  include Stella::App::Base

  def index
    publically do
      if sess.authenticated?
        view = Stella::App::Views::Dashboard.new req, sess, cust, req.params
        res.body = view.render
      else
        view = Stella::App::Views::Homepage.new req, sess, cust, req.params
        res.body = view.render
      end
    end
  end

  def send_feedback
    noshrimp!
    publically do
      assert_params :msg
      logic = Stella::Logic::Feedback.new sess, cust, req.params
      if logic.submitted_uri?
        sess.add_info_message! 'You submitted a URI. Click "Run Checkup" to continue!'
        sess.set :highlight_button, true
        res.redirect "/?uri=#{logic.message}"
      else
        logic.raise_concerns
        logic.submit_feedback
        sess.add_info_message! "Message received. Thanks!"
        res.redirect '/'
      end
    end
  end

  def slow
    time = 2.seconds
    sleep time
    res.body = "slept for %d" % time
  end

  def timeout
    time = 21.seconds
    sleep time
    res.body = "slept for %d" % time
  end

  def error
    raise "bad error, man"
  end

  def not_found
    not_found_response "Not found"
  end

  def server_error
    error_response "We experienced an error"
  end

end


module Stella::App::Views

  class NotFound < Stella::App::View
    def init *args
      @title = "Not Found"
    end
  end

  class Error < Stella::App::View
    def init *args
      @title = "Oh cripes!"
    end
  end

  class Homepage < Stella::App::View
    attr_accessor :convo
    def init *args
      @body_class = 'home'
      @title, @title_subtext = 'Web Monitoring with Stella', 'Is your site fast?'
      @description = 'Stella is a tool for web monitoring and debugging. Check up on your site right now or monitor it to receive notifications if it goes down. Is your site fast?'
      @css << '/app/style/component/home.css'
      #@css << '/app/style/component/news.css'
      @with_convo_heading = false
      @with_navbar = false
      @show_feedback_form = true
      self[:highlight_button] = (sess && sess.get!(:highlight_button)) || !req.params[:uri].to_s.empty?
      self[:checkup_uri] = Stella::Utils.uri(req.params[:uri]) if req.params[:uri]
    end
  end


  class Dashboard < Stella::App::View
    attr_reader :duration
    def init *args
      @title = "Dashboard"
      @body_class = 'dashboard'
      @css << '/app/style/component/dashboard.css'
      @js << '/etc/jquery/jquery.sparkline.min.js'
      self[:highlight_button] = (sess && sess.get!(:highlight_button)) || !req.params[:uri].to_s.empty?
      self[:recent_checkups] = cust.checkups :created_at.gt => Stella.now-24.hours, :order => [ :created_at.desc ], :limit => 20 #, :conditions => [ :created_at.gt 1.days ]
      self[:checkup_uri] = Stella::Utils.uri(req.params[:uri]) if req.params[:uri]
    end
  end

end



class Stella::App::Hooks
  include Stella::App::Base

  def stripe
    publically do
      Stella.li '[stripe] %s' % req.params.to_json
      res.body = "Thanks Stripe"
    end
  end

  def twilio
    publically do
      Stella.li '[twilio] %s' % req.params.to_json
      res.body = "Thanks Twilio"
    end
  end
end

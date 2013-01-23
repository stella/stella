require 'dm-serializer'

class Stella::App::Homepage
  include Stella::App::Base

  def index
    publically do
      token = '03b7cd5670eb44f8caffe7cd171c12e5bcca87dd'
      #github = HTTParty.get('https://api.github.com/user?access_token=%s' % token)
      #p github.parsed_response.class
      #p github.parsed_response
      if !req.params[:error].to_s.empty?
        sess.add_error_message! "GitHub error: %s" % req.params[:error]
        res.redirect '/'
      end
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

  def authtest
    publically do
      view = Stella::App::Views::Authtest.new req, sess, cust
      res.body = view.render
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
    publically do
      not_found_response "Not found"
    end
  end

  def server_error
    publically do
      error_response "We experienced an error"
    end
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
      self[:highlight_button] = (sess && sess.get!(:highlight_button)) || !req.params[:uri].to_s.empty?
      self[:recent_checkups] = cust.checkups :created_at.gt => Stella.now-24.hours, :order => [ :created_at.desc ], :limit => 20 #, :conditions => [ :created_at.gt 1.days ]
      self[:checkup_uri] = Stella::Utils.uri(req.params[:uri]) if req.params[:uri]
    end
  end

  class Authtest < Stella::App::View
    def init *args
      @title = "Success"
      @body_class = 'home'
      @css << '/app/style/component/home.css'
    end
  end

end


class Stella::App::Hooks
  include Stella::App::Base
  def twilio_text
    publically do
      Stella.li '[twilio] %s' % req.params.to_json
      res.body = %Q{<Response><Sms>Thanks for the feedback.</Sms></Response>}
      Stella::Analytics.event "Text Received"
    end
  end
  def twilio_call
    publically do
      Stella.li '[twilio] %s' % req.params.to_json
      res.body = %Q{<Response>
      <Say>Good day, you have reached Tucker at the Blamey and Stella Information Company.</Say>
      <Pause length="1"/>
      <Say>I am not able to take messages on this line. Please contact me via our internet website: www.blamestella.com</Say>
      <Pause length="1"/>
      </Response>}
      Stella::Analytics.event "Call Received"
    end
  end
end

class Stella::App::Auth
  include Stella::App::Base

  # See: http://developer.github.com/v3/oauth/
  def github_redirect
    publically do
      sess[:github_state] = [Stella.secret, SecureRandom.hex, :github_state].gibbler
      params = {
        :client_id => Stella.config['vendor.github.client'],
        :redirect_uri => app_uri('/auth/github/callback'),
        :scope => 'user:email', #'user,repo:status,gist',
        :state => sess[:github_state]
      }
      Stella.ld '[to-github] %s' % params
      res.redirect 'https://github.com/login/oauth/authorize?%s' % [params.to_http_params]
    end
  end

  def github_callback
    publically('/login') do
      #assert_params :code, :state
      Stella.ld '[from-github] %s' % req.params
      if req.get? && req.params[:state] == sess[:github_state]
        uri = 'https://github.com/login/oauth/access_token'
        params = {
          :client_id => Stella.config['vendor.github.client'],
          :client_secret => Stella.config['vendor.github.secret'],
          :code => req.params[:code],
          :state => sess[:github_state]
        }
        headers = {
          'Accept' => 'application/json'
        }
        Stella.ld '[github-token-params] %s' % params
        github = HTTParty.post(uri, :body => params, :headers => headers)
        Stella.ld '[github-response] %s' % github.parsed_response
        sess[:github_state] = nil
        if github['access_token']
          logic = Stella::Logic::GitHubSignup.new sess, cust, {:token => github['access_token']}
          logic.raise_concerns
          logic.process
          res.redirect '/'
        else
          sess.add_error_message! "Did not get a token. Please try again."
          res.redirect '/'
        end
      else
        sess.add_error_message! "Cannot authenticate with Github at this time."
        res.redirect '/'
      end
    end
  end

end

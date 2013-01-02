
class Stella::App::Account
  include Stella::App::Base
  def update
    authenticated do
      logic = BS::Logic::Account.new sess, cust, req.params
      logic.raise_concerns :update_account
      logic.update_customer
      sess.msg! "Changes saved."
      res.redirect '/account'
    end
  end

  def update_password
    authenticated('/account') do
      assert_params :old, :new, :new2
      logic = BS::Logic::ChangePassword.new @sess, @cust, req.params
      logic.raise_concerns
      logic.update_customer
      sess.msg! "Password changed."
      res.redirect '/account'
    end
  end

  def profile
    publically do
      assert_params :custid
      thiscust = Customer.from_redis req.params[:custid]
      raise BS::MissingItem if thiscust.nil?
      view = Stella::App::Views::Profile.new req, sess, cust, thiscust
      res.body = view.render
    end
  end

  def spreedly_refresh_info
    authenticated('/dashboard') do
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
      res.redirect '/dashboard'
    end
  end

  def feedback
    publically do
      favorites ||= ::Feedback.favorites.revmembers
      view = Stella::App::Views::Feedback.new req, sess, cust, req.params
      view.favorites = favorites
      res.body = view.render
    end
  end

  def product 
    publically do
      view = Stella::App::Views::Product.new req, sess, cust, req.params
      res.body = view.render
    end
  end

  def send_feedback
    noshrimp!
    publically do
      assert_params :i
      logic = BS::Logic::Feedback.new sess, cust, req.params
      if logic.submitted_uri?
        sess.msg! 'You submitted a URI into the comment form. Click "Run Checkup" to continue!'
        sess.set! :highlight_button, true
        res.redirect "/?uri=#{logic.message}"
      else
        logic.raise_concerns
        logic.submit_feedback
        sess.msg! "Secret message received! Send as much as you like."
        res.redirect '/'
      end
    end
  end

  def login_reset_secret_request
    publically do
      raise AlreadyAuthorized.new(cust) if sess.authenticated?
      if req.post?
        assert_params :email
        logic = BS::Logic::PasswordReset.new @sess, @cust, req.params
        logic.raise_concerns
        logic.process_reset
        sess.msg! "Expect an email shortly!"
        res.redirect '/'
      else
        secret = Secret.from_redis req.params[:secret]
        view = Stella::App::Views::LoginReset.new req, sess, cust
        res.body = view.render
      end
    end
  end
  def login_reset_pword_change
    publically do
      assert_params :secret
      raise AlreadyAuthorized.new(cust) if sess.authenticated?
      secret = Secret.from_redis req.params[:secret]
      if secret.nil?
        res.redirect '/'
      else
        guest_cust = Customer.from_redis secret.custid
        secret.destroy!
        BS.info " changing password for: #{guest_cust.custid}"
        logic = BS::Logic::Account.new sess, guest_cust, req.params
        logic.raise_concerns :change_password
        logic.update_customer
        if req.params[:new].to_s.size < 6
          sess.err! "Your short password frightens me. Go long!"
        elsif req.params[:new].to_s == "password"
          sess.err! "Your password cannot literally be 'password'."
        elsif req.params[:new].to_s != req.params[:new2].to_s
          sess.err! "The repeated password doesn't match."
        else
          guest_cust.update_password req.params[:new]
          sess.msg! "Password changed. You can now login."
        end
        res.redirect '/login'
      end
    end
  end

  def pricing
    publically do
      if Stella.config['site.disable_signups'].to_s == 'true'
        raise Stella::App::Problem, "Signup disabled for #{Stella.config.server}. Try www.blamestella.com."
      end
      cust.spreedly.update_data unless cust.anonymous? || cust.spreedly_data?
      view = Stella::App::Views::Pricing.new req, sess, cust
      res.body = view.render
    end
  end

  def index
    authenticated do
      quiet_timeout do
        cust.spreedly.update_data unless cust.spreedly_data?
      end
      view = Stella::App::Views::Account.new req, sess, cust
      res.body = view.render
    end
  end


  def signup
    publically(req.path) do
      if Stella.config['site.disable_signups'].to_s == 'true'
        raise Stella::App::Problem, "Signup disabled for #{Stella.config.server}. Try www.blamestella.com."
      end
      if req.post?
        #assert_params :email, :password
        logic = Stella::Logic::Signup.new(sess, cust, req.params)
        logic.raise_concerns
        logic.process 
        # We need to overwrite the existing session and customer
        @sess, @cust = logic.sess, logic.cust
        res.redirect req.path
      else
        view = Stella::App::Views::Signup.new req, sess, cust
        res.body = view.render
      end
    end
  end

end

module Stella::App::Views
  
  class Profile < Stella::App::View
    attr_reader :thiscust
    def init thiscust
      @thiscust = thiscust
      @title = "%s's profile" % [h(@thiscust.custid)]
      self[:thisgravatar] = gravatar(@thiscust.email)
      self[:member_since] = natural_time(@thiscust.created || Stella.now.to_i)
      self[:yourprofile] = thiscust.custid == cust.custid
    end
  end
  
  
  class Pricing < Stella::App::View
    attr_reader :plans
    def init *args
      @title = "Pricing & Signup"
      @body_class = "pricing"
      @plans = BS::Product.plans.values.collect { |plan|
        next if BS::Product::Free == plan
        { :code => plan.code,
          :name => plan.name,
          :name_up => plan.name.upcase,
          :name_down => plan.name.downcase,
          :price => plan.price.to_i,
          :monitors => plan.feature.monitors.opts[:max],
          :interval => plan.feature.interval.opts[:min].in_minutes.to_i,
          :plan_signup_uri => plan.spreedly_signup_uri(cust),
          :desc => plan.desc,
          :downgrade => plan < cust.product,
          :upgrade => plan > cust.product,
          :current_product => plan == cust.product
        }
      }.compact
      @css << '/app/style/component/pricing.css'
    end
  end


  class Signup < Stella::App::View
    attr_reader :product, :free_plan, :coupon_code
    def init *args
      #@product = BS::Product.plan(req.params[:product])
      @title = "Signup"
      @body_class = "login"
      #@free_plan = @product.price.zero?
      @coupon_code = params[:signup_code] || @sess.get!(:signup_code) || 'Have a coupon code?'
    end
  end

  class Login < Stella::App::View
    def init *args
      @title = "Login"
    end
  end

  class LoginReset < Stella::App::View
    attr_reader :secret
    def init *args
      @title = "Reset Password"
      if params[:secret]
        @secret = Secret.from_redis params[:secret]
      end
    end
  end
  
end
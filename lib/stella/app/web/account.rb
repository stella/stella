require 'stripe'

class Stella::App::Account
  include Stella::App::Base

  def contributors
    publically do
      if !sess.authenticated? && req.post?
        sess.add_info_message! "You'll need to sign in before agreeing."
        res.redirect '/signin'
      end
      if sess.authenticated? && req.post?
        if !req.params[:contributor].to_s.empty?
          if !cust.contributor_at
            cust.contributor = req.params[:contributor]
            cust.contributor_at = Stella.now
            cust.save
          end
          sess.add_info_message! "You are now a contributor!"
          res.redirect "/"
        else
          sess.add_info_message! "You need to sign and agree, one way or the other."
          res.redirect '/contributors'
        end
      else
        view = Stella::App::Views::Account::Contributor.new req, sess, cust
        res.body = view.render
      end
    end
  end

  def testsms
    authenticated('/account') do
      enforce_method! :POST
      if req.params[:contactid]
        contact = Stella::Contact.first :contactid => req.params[:contactid], :customer => cust
        phone = contact.phone if contact
      else
        phone = cust.phone
      end
      if phone
        args = {
          :message => "Hello from Stella. This is Tucker",
          :phone => phone
        }
        logic = Stella::Logic::SendSMS.new sess, cust, args
        logic.raise_concerns
        logic.process
        sess.add_info_message! "Message sent to #{logic.phone}."
        res.redirect '/account'
        Stella::Analytics.event "Sent Test SMS"
      else
        not_found_response "No such contact"
      end
    end
  end

  def update
    authenticated('/account') do
      enforce_method! :POST
      logic = Stella::Logic::Account.new sess, cust, req.params
      logic.raise_concerns :update_account
      logic.process
      sess.add_info_message! "Changes saved."
      res.redirect '/account'
    end
  end

  #def update_password
  #  privately('/account') do
  #    assert_params :old, :new, :new2
  #    logic = BS::Logic::ChangePassword.new @sess, @cust, req.params
  #    logic.raise_concerns
  #    logic.update_customer
  #    sess.msg! "Password changed."
  #    res.redirect '/account'
  #  end
  #end

  def delete
    authenticated('/account') do
      enforce_method! :POST
       assert_params :confirm, :custid
       if req.params[:confirm] && cust.custid == req.params[:custid]
         cust.destroy!
         res.delete_cookie :sess
         sess.destroy! :all
         @cust = Stella::Customer.anonymous
         @sess = Stella::Session.new
         Stella::Analytics.event "Delete account"
         res.redirect '/'
       else
        sess.add_info_message! "Account was not deleted. You must click confirm."
        res.redirect '/account'
      end
    end
  end

  def addcontact
    authenticated('/account/contact') do
      enforce_method! :POST
      assert_params :email
      logic = Stella::Logic::AddContact.new sess, cust, req.params
      logic.raise_concerns
      contact = logic.process
      res.body = json({
        :name => contact.name, :email => contact.email, :phone => contact.phone, :contactid => contact.contactid
      })
      res.redirect "/account/contacts" unless req.ajax?
      Stella::Analytics.event "Add Contact"
    end
  end

  def deletecontact
    authenticated('/account/contact') do
      enforce_method! :POST
      assert_params :contactid
      logic = Stella::Logic::DeleteContact.new sess, cust, req.params
      logic.raise_concerns
      contact = logic.process
      res.body = json({
        :success => true, :msg => "Contact deleted"
      })
      res.redirect "/account/contacts" unless req.ajax?
      Stella::Analytics.event "Delete Contact"
    end
  end

  def logout
    publically do
      if sess.authenticated?
        res.delete_cookie :sess
        sess.destroy! :all
        @cust = Stella::Customer.anonymous
        @sess = Stella::Session.new
      end
      res.redirect '/'
    end
  end

  def login
    publically do
      if req.post?
        logic = Stella::Logic::Login.new sess, cust, req.params
        if sess.authenticated?
          sess.add_info_message! "You are already logged in."
          res.redirect '/'
        else
          logic.raise_concerns
          logic.process
          res.send_cookie :sess, logic.sess.sessid, logic.sess.ttl, !local?
          res.redirect '/'
        end
      else
        view = Stella::App::Views::Account::Signin.new req, sess, cust
        res.body = view.render
      end
    end
  end

  def signup
    publically do
      if req.post?
        if sess.authenticated?
          sess.add_info_message! "You already have an account."
          res.redirect '/'
        else
          #assert_params :email, :password
          logic = Stella::Logic::Signup.new(sess, cust, req.params)
          logic.raise_concerns
          logic.process
          # We need to overwrite the existing session and customer
          @sess, @cust = logic.sess, logic.cust
          res.redirect '/'
        end
      else
        view = Stella::App::Views::Account::Signup.new req, sess, cust
        res.body = view.render
      end
    end
  end

  def confirm
    publically do
      #assert_params :secret
      if req.post?
      else
        view = Stella::App::Views::Account::Confirm.new req, sess, cust
        begin
          secret = Stella::Secret.load req.params[:secret] if req.params[:secret]
        rescue Stella::MissingItem => ex
          Stella.ld ex.message
        end
        if secret && secret.type?('confirm-account')
          secret_cust = secret.load_customer
          secret_cust.confirmed_at = Stella.now
          secret_cust.save
          secret.destroy!
          @cust = secret_cust
          sess[:custid] = cust.custid
          sess[:authenticated] = true
          view.success = true
        end
        res.body = view.render
      end
    end
  end


  def login_reset_secret_request
    publically do
      raise AlreadyAuthorized.new(cust) if sess.authenticated?
      if req.post?
        assert_params :email
        logic = Stella::Logic::PasswordResetEmail.new sess, cust, req.params
        logic.raise_concerns
        logic.process_reset
        sess.add_info_message! "Expect an email shortly!"
        res.redirect '/'
      else
        begin
          view = Stella::App::Views::Account::PasswordReset.new req, sess, cust
          view.secret = Stella::Secret.load req.params[:secret] if req.params[:secret]
          res.body = view.render
        rescue Stella::MissingItem => ex
          Stella.ld ex.message
          sess.add_info_message! "No such secret"
          res.redirect '/'
        end
      end
    end
  end
  def login_reset_pword_change
    publically do
      assert_params :secret
      raise AlreadyAuthorized.new(cust) if sess.authenticated?
      begin
        secret = Stella::Secret.load req.params[:secret] if req.params[:secret]
      rescue Stella::MissingItem => ex
        Stella.ld ex.message
      end
      if secret && secret.type?('password-reset')
        secret_cust = secret.load_customer
        Stella.li " changing password for: #{secret_cust.email}"
        logic = Stella::Logic::UpdatePassword.new sess, secret_cust, req.params
        logic.skip_password_check = true
        logic.raise_concerns :change_password
        logic.update_customer
        secret.destroy!
        sess.add_info_message! "Password changed. You can now login."
        res.redirect '/login'
      else
        sess.add_info_message! "Password was not changed."
        res.redirect '/'
      end


    end
  end
  def index
    authenticated do
      view = Stella::App::Views::Account::Index.new req, sess, cust
      res.body = view.render
    end
  end

  def api
    authenticated do
      view = Stella::App::Views::Account::Index.new req, sess, cust
      view.tab = :api
      res.body = view.render
    end
  end

  def billing
    authenticated do
      view = Stella::App::Views::Account::Billing.new req, sess, cust
      res.body = view.render
    end
  end


  # 4242424242424242

  # https://stripe.com/docs/tutorials/charges
  # https://stripe.com/docs/subscriptions - create a free plan
  # https://stripe.com/docs/webhooks#responding_to_a_webhook - use metered billing webhook
  def receive_token
    publically do
      if req.post?
        res.header['Content-Type'] = "text/plain"

        # set your secret key: remember to change this to your live secret key in production
        # see your keys here https://manage.stripe.com/account
        Stripe.api_key = "sk_0Jr3LdfdbLofD4rCiGVOQMWe14SKx"

        # get the credit card details submitted by the form
        token = req.params[:stripeToken]

        #
        # ONE TIME CHARGE
        #

        # create the charge on Stripe's servers - this will charge the user's card
        #charge = Stripe::Charge.create(
        #  :amount => 1000, # amount in cents, again
        #  :currency => "cad",
        #  :card => token,
        #  :description => "payinguser@example.com"
        #)

        #
        # CREATE A RECURRING CUSTOMER
        #

        # create a Customer
        customer = Stripe::Customer.create(
          :card => token,
          :description => req.to_yaml.gibbler.shorten
        )
        customer_id = customer.id

        # charge the Customer instead of the card
        Stripe::Charge.create(
            :amount => 1000, # in cents
            :currency => "cad",
            :customer => customer.id
        )

        # save the customer ID in your database so you can use it later
        #save_stripe_customer_id(user, customer.id)

        # later
        #customer_id = get_stripe_customer_id(user)

        charge = Stripe::Charge.create(
            :amount => 1500, # $15.00 this time
            :currency => "cad",
            :customer => customer_id
        )


        res.body = req.to_yaml

        puts charge.to_yaml
      end
    end
  end

end

module Stella::App::Views

  module Account
    class Index < Stella::App::View
      attr_accessor :tab
      def init *args
        @title = "Your Account"
        @tab = :profile
        #self[:hello_style] = :mustache_hello
        self[:tabs] = [
          {:tab => :profile, :text => "Account", :active => true },
          {:tab => :contacts,:text => "Contacts" },
          {:tab => :api,     :text => "API Credentials" },
          {:tab => :sites,   :text => "Sites" }
        ]
        self[:selected_tabid] = req.params[:tabid]
        self[:tabs] << {:tab => :machines, :text => "Machines" } if cust.colonel?
        self[:hosts] = cust.hosts :order => [ :response_time.desc, :hidden ]
      end
    end

    class Billing < Stella::App::View
      attr_accessor :tab
      def init *args
        @title = "Billing"
        @tab = :products
        self[:tabs] = [
          {:tab => :products,  :text => "Products", :active => true },
          #{:tab => :payment,   :text => "Payment Info" },
          {:tab => :history,   :text => "History" }
        ]
        self[:selected_tabid] = req.params[:tabid]
      end
    end

    class Confirm < Stella::App::View
      attr_accessor :success
      def init *args
        @title = "Account Confirmation"
        self[:hello_style] = :simple_hello
      end
    end

    class Signin < Stella::App::View
      attr_accessor :success
      def init *args
        @title = "Sign In"
        self[:hello_style] = :mustache_hello
        self[:email] = params['email']
      end
    end

    class Signup < Stella::App::View
      attr_accessor :success
      def init *args
        @title = "Sign Up"
        self[:hello_style] = :mustache_hello
        self[:email] = params['email']
        if req.params[:hostid]
          self[:host] = Stella::Host.first :hostid => req.params[:hostid]
        end
      end
    end

    class PasswordReset < Stella::App::View
      attr_accessor :secret
      def init *args
        @title = "Reset Password"
      end
    end

    class Contributor < Stella::App::View
      attr_accessor :secret
      def init *args
        @title = "Contribute"
        self[:abider] = cust.contributor?(:abider)
        self[:outlaw] = cust.contributor?(:outlaw)
      end
    end

  end

end

require 'stella/logic'
require 'stella/email'

class Stella::Logic::Signup < Stella::Logic::Base
  attr_reader :email, :password, :host, :checkup, :testplan, :secret, :secret_uri
  def raise_concerns
    exclass = Stella::App::SignupError
    check_rate_limits! :signup
    if Stella.config['site.allow_signups'].to_s == 'false' && !cust.colonel?
      raise Stella::App::SignupError, "Signups are currently disabled."
    end
    if email.size < 4
      raise exclass.new("You did not enter an email address")
    #elsif !Stella.colonel?(email)
    #  raise exclass.new("Only colonels can signup (#{email})")
    elsif Stella::Customer.exists?( email )
      raise exclass.new("'#{email}' already has an account.")
    elsif !email.empty? && !valid_email?(email)
      raise exclass.new("That ain't a valid email: #{email}")
    elsif email.size > 64
      raise exclass.new("Your email address is too long!")
    elsif params[:checkid] && checkup.nil?
      raise exclass.new("Unknown checkup")
    elsif password.to_s.size < 4
      raise exclass.new("Your short password frightens me. Go long!")
    elsif password.to_s.size > 64
      raise exclass.new("Your password is too long!")
    elsif password.to_s == "password"
      raise exclass.new("Your password cannot literally be 'password'.")
    end
  end

  def process
    @cust = Stella::Customer.new :email => email
    cust.update_password password
    if Stella.colonel?(cust.email)
      cust.role = :colonel
      cust.confirmed_at = Stella.now
    end
    if checkup
      cust.checkups << checkup
      @host = Stella::Logic.safedb {
        Stella::Host.create :hostname => checkup.host.hostname, :custid => cust.custid, :customer => cust
      }
      @testplan = Stella::Logic.safedb {
        Stella::Testplan.create :uri => checkup.testplan.uri, :customer => cust, :host => host
      }
    elsif params[:hostid]
      hosttmp = Stella::Host.first :hostid => params[:hostid]
      @host = Stella::Logic.safedb {
        Stella::Host.create :hostname => hosttmp.hostname, :custid => cust.custid, :customer => cust
      }
    end
    if host
      if testplan
        host.testplans << testplan
      end
      host.start! :site_free_v1
      @hostname = host.hostname
      if host.screenshots.empty?
        Stella::Job::RenderHost.enqueue :hostid => host.hostid
      end
    end
    cust.save
    # TODO: Move to StartNewMonitor job
    unless cust.colonel?
      @secret = Stella::Secret.create :type => 'confirm-account', :custid => cust.custid
      @secret_uri = Stella::App::StaticHelpers.uri '/account/confirm', secret.objid
      welcome_msg = Stella::Email::Account::ExpressConfirmation.new cust, :hostname => @hostname, :uri => secret_uri
      welcome_msg.send_email
    end
    Stella.li "signup-success: #{cust.custid} #{cust.role}"
    sess[:custid] = cust.custid
    sess[:authenticated] = true
  end

  protected
  def valid_email?(email)
    !email.match(EMAIL_REGEX).nil?
  end
  def process_params
    @email = params[:email].to_s.downcase.strip
    @password = params[:password].to_s.strip
    @checkup = Stella::Checkup.first :checkid => params[:checkid]
  end
end


class Stella::Logic::Login < Stella::Logic::Base
  TTL = 30.days
  attr_reader :email, :password
  def raise_concerns
    check_rate_limits! :login
    if @cust.nil?
      args = [email, password.gibbler.short, sess[:ipaddress]]
      raise Stella::App::FailedAuthorization.new(*args)
    end
  end

  def process
    sess = Stella::Session.create @sess[:ipaddress], @sess[:user_agent], :custid => cust.custid
    @sess.destroy!   # get rid of the unauthenticated session ID
    @sess = sess
    sess[:authenticated] = true
    sess[:custid] = cust.custid
    sess.update_expiration Stella::Logic::Login::TTL
    Stella.li "[login-success] #{cust.email} #{cust.role} (#{cust.custid}/#{sess[:custid]}/#{sess[:authenticated]})"
    #TODO: @sess.expiration = 20.days
    #Stella::Customer.active.add Stella.now.to_i, @cust if @cust && @sess.authenticated?
    cust.role = :colonel if Stella.colonel?(cust.email)
    cust.save
  end

  protected

  def process_params
    @cust = nil  # remove the anonymous customer
    @email = params[:email].to_s.downcase.strip
    @password = params[:password].to_s.strip
    @stay = params[:stay].to_s == "true"

    if email.index(':as:')
      @colonelemail, @email = *email.downcase.split(':as:')
    end

    potential = Stella::Customer.first :email => email
    potential ||= Stella::Customer.first :nickname => email

    if potential && potential.outdated_password?
      raise Stella::App::PasswordUpdateRequired.new potential.email
    end

    if @colonelemail && potential
      Stella.li "[login-as-attempt] #{@colonelemail} as #{@email} #{@sess[:ipaddress]}"
      colonel = Stella::Customer.first :email => @colonelemail
      colonel ||= Stella::Customer.first :nickname => @colonelemail
      if colonel && colonel.colonel? && colonel.password?(password)
        @cust = potential
      else
        Stella.li "[login-as-failed] #{@colonelemail} as #{@email} #{@sess[:ipaddress]}"
      end
    elsif potential && potential.password?(password)
      @cust = potential
    end
  end
end

class Stella::Logic::PasswordResetEmail < Stella::Logic::Base
  attr_reader :email
  def raise_concerns
    check_rate_limits! :reset_password
    exklass = Stella::App::SignupError
    if !valid_email?(@email)
      raise exklass.new("That ain't a valid email: #{params[:email]}")
    elsif (@this_cust = Stella::Customer.first(:email => @email)).nil?
      raise exklass.new("That address does not look familiar.")
    end
  end

  def process_reset
    Stella.li "Sending password reset email to #{@this_cust.email}"
    secret = Stella::Secret.create :type => 'password-reset', :custid => @this_cust.custid
    secret_uri = Stella::App::StaticHelpers.uri '/login/reset', secret.objid
    welcome_msg = Stella::Email::Account::PasswordReset.new @this_cust, :uri => secret_uri
    #puts welcome_msg.render
    welcome_msg.send_email
  end

  protected
  def valid_email?(email)
    !email.to_s.empty? && !email.match(EMAIL_REGEX).nil?
  end
  def process_params
    @email = params[:email].to_s.strip
  end
end

class Stella::Logic::UpdatePassword < Stella::Logic::Base
  attr_accessor :skip_password_check
  def raise_concerns(event=:change_password)
    #check_rate_limits! event
    if !skip_password_check && !@cust.password?(params[:old])
      raise Stella::App::Problem.new("Old password does not match.")
    elsif @new_password.to_s.size < 6
      raise Stella::App::Problem.new("Your short password frightens me. Go long!")
    elsif @new_password.to_s == "password"
      raise Stella::App::Problem.new("Your password cannot literally be 'password'.")
    elsif @new_password.to_s != @new_password_repeat
      raise Stella::App::Problem.new("The repeated password doesn't match.")
    elsif @cust.password?(@new_password)
      raise Stella::App::Problem.new("Please try another password.")
    else
      #raise Stella::App::Problem.new("That password is weird. Please try another.")
    end
  end

  def update_customer
    @cust.update_password @new_password
    @cust.save
  end

  protected
  def process_params
    @new_password = params[:new].to_s.strip
    @new_password_repeat = params[:new2].to_s.strip
  end

end

require 'stella/logic'
require 'stella/email'

class Stella::Logic::AddContact < Stella::Logic::Base
  attr_reader :email, :name, :phone, :contact
  def raise_concerns(event=:add_contact)
    if !valid_email?(email)
      raise Stella::App::Problem.new("Inavlid email: #{email}")
    end
    if phone && !valid_phone?(phone)
      raise Stella::App::Problem.new("Inavlid phone: #{phone}")
    end
  end
  def process
    opts = {:email => email, :customer => cust}
    opts[:name] = name if name
    opts[:phone] = phone if phone
    @contact = Stella::Contact.create opts
  rescue DataObjects::IntegrityError => ex
    raise Stella::DuplicateItem, "That contact already exists"
  end
  def process_params
    @email = params[:email].to_s.strip
    @phone = params[:phone].to_s.strip
    @name = params[:name].to_s.strip
    @email = nil if @email.empty?
    @phone = nil if @phone.empty?
    @name = nil if @name.empty?
  end
end

class Stella::Logic::DeleteContact < Stella::Logic::Base
  attr_reader :contactid, :contact
  def raise_concerns(event=:delete_contact)
    raise Stella::App::Problem, "No such contact" if contact.nil?
  end
  def process
    contact.destroy
  end
  def process_params
    @contactid = params[:contactid].to_s.strip
    @contact = cust.contacts :contactid => contactid
  end
end

class Stella::Logic::Account < Stella::Logic::Base
  unless defined?(Account::UPDATEABLE_FIELDS)
    UPDATEABLE_FIELDS = [:name, :phone, :website, :company, :location].freeze
  end

  def raise_concerns(event)
    #check_rate_limits! event
    # NOTE: not tested, doesn't work:
    #tmpcust = Stella::Customer.first(:nickname => params[:nickname])
    #if tmpcust && tmpcust.email != cust.email
    #  raise Stella::App::Problem.new("That email address is not available.")
    #end
  end

  def process_params
    UPDATEABLE_FIELDS.each do |field|
      next if params[field].nil?
      params[field].strip!
    end

    if !params[:email].to_s.empty? && !valid_email?(params[:email])
      raise Stella::App::Problem.new("Inavlid email: #{params[:email]}")
    end

    params[:phone] = Stella::Logic.normalize_phone(params[:phone])
    if !params[:phone].to_s.empty? && !valid_phone?(params[:phone])
      raise Stella::App::Problem.new("Inavlid phone: #{params[:phone]}")
    end

    if params[:website]
      uri = URI.parse params[:website] rescue nil
      if uri.nil?
        raise Stella::App::Problem.new("Invalid website: #{params[:website]}")
      end
    end

    @params = params
  end

  def process
    UPDATEABLE_FIELDS.each do |field|
      next if params[field].nil? || @cust.send(field) == @params[field]
      cust.send("#{field}=", params[field])
    end
    cust.save # won't save if no change
  end

  def create_uri(host)
    host = host.strip if String === host
    host = "http://#{host}" unless host.match(/^https?:\/\//)
    uri = URI.parse(host)
    uri.host ||= ''
    uri.path = '/' if uri.path.nil? || uri.path.empty?
    uri
  end

end

class Stella::Logic::GitHubSignup < Stella::Logic::Base
  attr_reader :token, :github
  def raise_concerns
    raise Stella::App::Problem, 'No github token provided' if token.empty?
    @github = HTTParty.get('https://api.github.com/user?access_token=%s' % token)
  end
  def process
    if github['email'].to_s.empty?
      github['email'] = '%s+GITHUB@blamestella.com' % github['login']
    end
    @cust = Stella::Customer.first(:github_token => token, :nickname => github['login'])
    new_cust = false
    if cust.nil?
      if !Stella::Customer.first(:email => github['email']).nil?
        raise Stella::App::SignupError.new(github['email'], "#{github['email']} already has an account. Try logging in.")
      elsif !Stella::Customer.first(:nickname => github['login']).nil?
        raise Stella::App::SignupError.new(github['login'], "#{github['login']} already has an account. Try logging in.")
      end
      @cust = Stella::Customer.new :email => github['email'], :nickname => github['login']
      new_cust = true
    end
    cust.name = github['name']
    cust.location = github['location']
    cust.company = github['company']
    cust.nickname = github['login']
    cust.github_token = token
    cust.data['github'] = github.parsed_response
    begin
      cust.save
    rescue DataObjects::IntegrityError => ex
      Stella.ld ex.message
      Stella.ld ex.backtrace
      raise Stella::App::Problem.new("We ran into a problem. You are authorized to give Tucker heck!")
    end
    sess[:custid] = cust.custid
    sess[:authenticated] = true
    if new_cust
      welcome_msg = Stella::Email::Account::Welcome.new cust, :via => :github
      welcome_msg.send_email
      Stella::Analytics.event "New Customers"
    end
  end

  protected
  def process_params
    @token = params[:token].to_s
  end
end

class Stella::Logic::Signup < Stella::Logic::Base
  attr_reader :email, :password, :host, :checkup, :testplan, :secret, :secret_uri
  def raise_concerns
    exclass = Stella::App::SignupError
    check_rate_limits! :signup
    if Stella.config['site.allow_signups'].to_s == 'false' && !cust.colonel?
      raise Stella::App::Problem.new("Signups are currently disabled.")
    end
    if email.size < 4
      raise exclass.new("You did not enter an email address")
    #elsif !Stella.colonel?(email)
    #  raise exclass.new("Only colonels can signup (#{email})")
    elsif Stella::Customer.exists?( email )
      raise exclass.new(email, "'#{email}' already has an account.")
    elsif !email.empty? && !valid_email?(email)
      raise exclass.new(email, "That ain't a valid email: #{email}")
    elsif email.size > 64
      raise exclass.new(email, "Your email address is too long!")
    elsif params[:checkid] && checkup.nil?
      raise exclass.new(email, "Unknown checkup")
    elsif password.to_s.size < 4
      raise exclass.new(email, "Your short password frightens me. Go long!")
    elsif password.to_s.size > 64
      raise exclass.new(email, "Your password is too long!")
    elsif password.to_s == "password"
      raise exclass.new(email, "Your password cannot literally be 'password'.")
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
      Stella::Analytics.event "Start Monitor"
      @hostname = host.hostname
      if host.screenshots.empty?
        Stella::Job::RenderHost.enqueue :hostid => host.hostid
      end
    end
    cust.save
    # TODO: Move to ExpressConfirmation job
    unless cust.colonel?
      @secret = Stella::Secret.create :type => 'confirm-account', :custid => cust.custid
      @secret_uri = Stella::App::StaticHelpers.uri '/account/confirm', secret.objid
      welcome_msg = Stella::Email::Account::ExpressConfirmation.new cust, :hostname => @hostname, :uri => secret_uri
      welcome_msg.send_email
    end
    Stella.li "signup-success: #{cust.custid} #{cust.role}"
    sess[:custid] = cust.custid
    sess[:authenticated] = true
    Stella::Analytics.event "New Customers"
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
      Stella::Analytics.event "Login (failed)"
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
    Stella::Analytics.event "Login (success)"
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
      raise exklass.new(params[:email], "That ain't a valid email: #{params[:email]}")
    elsif (@this_cust = Stella::Customer.first(:email => @email)).nil?
      raise exklass.new(params[:email], "That address does not look familiar.")
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

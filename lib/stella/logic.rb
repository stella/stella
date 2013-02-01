

module Stella::Logic
  class Base
    unless defined?(Stella::Logic::Base::PHONE_REGEX)
      PHONE_REGEX = /^\+?\d{9,16}$/
      EMAIL_REGEX = %r{^(?:[\+_a-z0-9-]+)(\.[\+_a-z0-9-]+)*@([a-z0-9-]+)(\.[a-zA-Z0-9\-\.]+)*(\.[a-z]{2,4})$}i
    end

    attr_reader :sess, :cust, :params, :processed_params
    def initialize(sess, cust, params=nil)
      @sess, @cust, @params = sess, cust, params
      @processed_params ||= {}
      process_params if respond_to?(:process_params) # && @params
      process_generic_params if @params
    end

    def valid_email?(email)
      !email.match(EMAIL_REGEX).nil?
    end

    def valid_phone?(phone)
      !phone.match(PHONE_REGEX).nil?
    end

    protected

    def safedb
      yield
    rescue DataMapper::PersistenceError => ex
      # SaveFailureError, UpdateConflictError, UnsavedParentError
      Stella.ld [ex.class, ex.message].inspect
      ex.resource.errors.each { |e| Stella.ld e }
      nil
    end

    # can raise BS::UserLimitError or BS::HostLimitError
    def check_rate_limits!(event)
      # NOTE: In production, the elastic load balancers will report
      # an internal IP address (of the LB) for SSL connections.
      #identifier = @sess.authenticated? ? @cust.custid : @sess[:ipaddress]
      #host = @uri ? Stella.canonical_host(@uri) : nil
      #unless host.nil?
      #  if HostInfo.owner?(host, @cust) && @cust.paying?
      #    Stella.ld " #{@cust.custid} is the paying owner of #{host}"
      #  else
      #    Stella.ld " #{@cust.custid} isn't the paying owner of #{host}"
      #    HostLimiter.increment! host, event
      #  end
      #end
      #UserLimiter.increment! identifier, event
      #SiteLimiter.increment! BS.host, event if SiteLimiter.threshold[event]
    end

    # Generic params that can appear anywhere are processed here.
    # This is called in initialize AFTER process_params so that
    # values set here don't overwrite values that already exist.
    def process_generic_params
      @processed_params[:epoint] ||= params[:epoint].to_i > 0 ? params[:epoint].to_i : Stella.now.to_i
      @processed_params[:duration] ||= params[:duration].to_i > 0 ? params[:duration].to_i : 4.hours.to_i
    end
  end

  def self.safedb
    yield
  rescue DataMapper::PersistenceError => ex
    # SaveFailureError, UpdateConflictError, UnsavedParentError
    Stella.li [ex.class, ex.message].inspect
    ex.resource.errors.each { |e| Stella.li e }
    nil
  end

  def self.normalize_phone(phone)
    return if phone.to_s.empty?
    ['+', phone.gsub(/\D/, '')].join
  end

  def self.valid_format?(format)
    ['json','jsonp','html','csv','yaml','atom','txt','xml'].member?(format.to_s)
  end
end

class Stella::Logic::Generic < Stella::Logic::Base
  def raise_concerns event=:generic
    check_rate_limits! event
  end
end

class Stella::Logic::ViewDocs < Stella::Logic::Base
  attr_reader :topic
  def raise_concerns(event=:generic)
    # do nothing
  end
  def process_params
    @topic = params[:topic].to_s.empty? ? :overview : params[:topic].gsub(/\W/, '')
  end
  def documentation
    self.class.read_topic_config(topic)
  end
  class << self
    attr_accessor :docdir
    def read_topic_config topic
      raise Stella::Problem, "Need to set docdir" if docdir.to_s.empty?
      read_config File.join(docdir, "#{topic}.yml")
    rescue => ex
      Stella.li "#{ex.message} (#{topic})"
      nil
    end
    def read_config path
      raise ArgumentError, "Bad config" unless File.extname(path) == '.yml'
      raise ArgumentError, "Bad config" unless File.owned?(path)
      YAML.load_file path
    end
  end
end

class Stella::Logic::SendSMS < Stella::Logic::Base
  attr_reader :message, :phone
  def raise_concerns
    #check_rate_limits! :send_sms
    raise Stella::NoPhone unless phone
    raise RuntimeError, "No message" unless message
    raise RuntimeError, "Message to long (#{message.size})" if message.size > 158
  end
  def process
    self.class.send_sms phone, message
  end
  protected
  def process_params
    @message = params[:message].to_s.strip
    @message = nil if @message.empty?
    @phone = params[:phone].to_s.strip
    @phone = nil if @phone.empty?
  end
  class << self
    def send_sms phone, msg
      @from ||= Stella.config['vendor.twilio.phone']
      Twilio::Sms.message(@from, phone, msg)
    end
  end
end

class Stella::Logic::Feedback < Stella::Logic::Base
  attr_reader :referrer, :message
  def raise_concerns
    check_rate_limits! :submit_feedback
    if @message =~ /\s*Say something to Tucker/ || @message =~ /\s*Ask Tucker about the API/
      raise Stella::Problem.new("You can be more original than that!")
    end
  end

  def submit_feedback
    # TODO: Send an email instead (once you have a phone where you can read email :] )
    from = Stella.config['vendor.twilio.phone']
    to = Stella.config['account.tech.phone']
    host = Stella.config['site.host']
    Stella.li "#{to} (#{@cust.email}): #{message}"
    feedback = @cust.create_feedback message
    begin
      Twilio::Sms.message(from, to, "[C] #{@cust.email} (#{host}): #{@message}.")
    rescue => ex
      Stella.li "Problem connecting to Twilio #{ex.message}"
    end
  end

  def submitted_uri?
    URI.parse(message).absolute?
  rescue
    false
  end

  protected
  def process_params
    #@referrer = URI.parse(params[:r] || '/')
    @message = @params[:msg].to_s.strip
    @message = @message.slice(0, 5000) if @message.size > 5000
  end
end

require 'stella/logic/account'
require 'stella/logic/checkup'
require 'stella/logic/machine'
require 'stella/logic/metrics'

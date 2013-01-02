require 'httparty'

class SendGrid
  include HTTParty
  base_uri 'https://sendgrid.com/api/'
  #debug_output $stdout
  attr_reader :opts, :response
  attr_accessor :status
  def initialize subject, content, opts={}
    @opts = {
      :to => nil,
      :bcc => nil,
      :from => nil,
      :fromname => nil,
      :reply_to => nil,
      :category => nil,
      :subject => subject,
      :html => content,
      :api_user => self.class.api_user,
      :api_key => self.class.api_key
    }.merge opts
    @status = :unsent
  end
  def send_email
    options = opts.clone
    options['x-smtpapi'] = {
      :category => options.delete(:category) || :notsure,
      :machine => Stella.sysinfo.hostname
    }
    options.delete(:bcc) if options[:bcc].to_s.empty?
    begin
      if SendGrid.fake?
        @status = :fake_sent
      else
        @response = SendGrid.post("/mail.send.json", :body => options)
        @status = :sent
      end
    rescue => ex
      @status = :error
      STDERR.puts "email-error: #{ex.message}", ex.backtrace
    end
  end
  def status? guess
    @status == guess.to_sym
  end
  class << self
    attr_accessor :fake, :api_user, :api_key, :hostname
    alias_method :fake?, :fake
    def send_email *args
      email = new *args
      email.send_email
      email
    end
  end
  @fake = false
end

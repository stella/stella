
class Stella::App
  class Unauthorized < RuntimeError
  end
  class NotFound < RuntimeError
  end
  class Redirect < RuntimeError
    attr_reader :location, :status
    def initialize l, s=302
      @location, @status = l, s
    end
  end

  class Problem < Stella::Problem
    def initialize *args
      @args = args
    end
    def message() @args[0] end
  end

  class MissingParam < Stella::App::Problem
    def message() "Missing parameter: #{@args[0]}" end
  end

  class FormError < Problem
    attr_accessor :form_fields, :message
  end

  class BadShrimp < Stella::App::Problem
    attr_reader :path, :user, :got, :wanted
    def initialize(path,user,got,wanted)
      @path, @user, @got, @wanted = path, user, got.to_s, wanted.to_s
    end
    def report()
      "BAD SHRIMP FOR #{@path}: #{@user}: #{got.shorten(16)}/#{wanted.shorten(16)}"
    end
    def message() "Sorry, bad shrimp" end
  end

  class LimitExceeded < RuntimeError
    attr_accessor :event, :message, :cust
    attr_reader :identifier, :event, :count
    def initialize identifier, event, count
      @identifier, @event, @count = identifier, event, count
    end
  end

  class AlreadyAuthorized < Stella::App::Problem
    attr_reader :customer
    def customer(c)
      @custid = c
    end
    def report()
      "#{self.class}: #{@customer.to_json}"
    end
    def message() "You're logged in!" end
  end

  class FailedAuthorization < Stella::App::Problem
    attr_reader :u, :p, :ipaddr
    def initialize(u, p, ipaddr)
      @u, @p, @ipaddr = u, p, ipaddr
    end
    def report()
      "#{self.class}: #{@u} #{@p} #{@ipaddr}"
    end
    def message() "Have we met?" end
  end

  class PasswordUpdateRequired < Stella::App::Problem
    attr_reader :email
    def initialize(e)
      @email = e
    end
  end

  class SignupError < Stella::App::Problem
    def report
      "signup-failed: #{message}"
    end
  end
  unless defined?(Stella::App::BADAGENTS)
    BADAGENTS = [:facebook, :google, :yahoo, :bing, :stella, :baidu, :bot, :curl, :wget]
    LOCAL_HOSTS = ['localhost', '127.0.0.1', 'www.bs.com', 'bs3-dev-01', 'bs3-dev-02', 'bs3-dev-03', 'dev-03.bs.com'].freeze
  end

  module Helpers

    attr_reader :req, :res
    attr_reader :sess, :cust
    attr_reader :ignoreshrimp
    def initialize req, res
      @req, @res = req, res
    end

    def carefully redirect=nil
      redirect ||= req.request_path
      # We check get here to stop an infinite redirect loop.
      # Pages redirecting from a POST can get by with the same page once.
      redirect = '/error' if req.get? && redirect.to_s == req.request_path

      yield

      res.header['Content-Type'] ||= "text/html; charset=utf-8"

    rescue Redirect => ex
      res.redirect ex.location, ex.status

    rescue Stella::App::NotFound => ex
      Stella.li ex.message
      not_found_response "Not found"

    rescue Stella::App::SignupError => ex
      sess.add_error_message! ex.message
      req.params.delete "password"
      req.params.delete "password2"
      sess.request_params.update req.params
      res.redirect redirect

    rescue Stella::App::PasswordUpdateRequired => ex
      res.redirect "#{redirect}?pwreset=1&email=#{ex.email}"

    rescue Stella::App::FailedAuthorization => ex
      sess.add_error_message! ex.message
      req.params.delete "password"
      req.params.delete "password2"
      sess.request_params.update req.params
      res.redirect redirect

    rescue Stella::App::Unauthorized => ex
      Stella.li ex.message
      not_found_response "Not authorized"

    rescue Stella::App::BadShrimp => ex
      sess.add_error_message! "Please go back, refresh the page, and try again."
      res.redirect redirect

    rescue Stella::UnknownHostname, Stella::LocalDomainError => ex
      sess.add_error_message! ex.message
      res.redirect redirect

    rescue Stella::App::FormError => ex  # TODO
      handle_form_error ex, redirect

    rescue Stella::App::LimitExceeded => ex
      err "[limit-exceeded] #{cust.custid}(#{sess[:ipaddress]}): #{ex.event}(#{ex.count}) #{sess.identifier.shorten(10)}"
      err req.current_absolute_uri
      error_response "Apologies dear citizen! You have been rate limited. Consider upgrading or try again in a few minutes."

    rescue Stella::App::Problem => ex
      sess.add_error_message! ex.message
      res.redirect redirect

    rescue Errno::ECONNREFUSED => ex
      Stella.li "Redis is down: #{ex.message}"
      error_response "Stella will be back shortly!"

    rescue => ex
      err "#{ex.class}: #{ex.message}"
      err req.current_absolute_uri
      err ex.backtrace.join("\n")
      error_response "An error occurred :["

    ensure
      @sess ||= Stella::Session.new :failover
      @cust ||= Stella::Customer.anonymous
    end

    def enforce_method! meth
      return if req.request_method.to_s.upcase == meth.to_s.upcase
      raise Stella::App::NotFound
    end

    def check_shrimp!
      return if @check_shrimp_ran
      @check_shrimp_ran = true
      return unless req.post? || req.put? || req.delete?
      attempted_shrimp = req.params[:shrimp]
      ### NOTE: MUST FAIL WHEN NO SHRIMP OTHERWISE YOU CAN
      ### JUST SUBMIT A FORM WITHOUT ANY SHRIMP WHATSOEVER.
      unless sess.shrimp?(attempted_shrimp) || ignoreshrimp
        shrimp = (sess[:shrimp] || '[noshrimp]').clone
        sess.clear_shrimp!  # assume the shrimp is being tampered with
        ex = Stella::App::BadShrimp.new(req.path, cust.custid, attempted_shrimp, shrimp)
        Stella.ld "BAD SHRIMP for #{cust.custid}@#{req.path}: #{attempted_shrimp}"
        raise ex
      end
    end

    def noshrimp!
      @ignoreshrimp = true
    end

    def check_session!
      return if @check_session_ran
      @check_session_ran = true
      if req.cookie?(:sess) && Stella::Session.exists?(req.cookie(:sess))
        @sess = Stella::Session.load req.cookie(:sess)
      else
        @sess = Stella::Session.create req.client_ipaddress, req.user_agent
      end
      #p sess.request_params.all
      #p sess.info_messages.values
      #p sess.error_messages.values
      res.send_cookie :sess, sess.sessid, sess.ttl, !local?
      @cust = sess.load_customer
      @cust ||= Stella::Customer.anonymous
      sess[:authenticated] = false if cust.anonymous?
      sess.update_expiration
    end

    # +names+ One or more a required parameter names (Symbol)
    def assert_params(*names)
      # NOTE: I don't think return works in Sinatra 1.0
      names.flatten.compact.each do |n|
        if req.params[n].nil? || req.params[n].empty?
          raise Stella::App::MissingParam, n
        end
      end
    end
    alias_method :assert_param, :assert_params

    def assert_exists(val, msg)
      return error_response(msg) if val.nil? || (val.respond_to?(:empty?) && val.empty?)
    end

    def assert_true(val, msg)
      return error_response(msg) if val == true
    end

    def secure_request?
      !local? || secure?
    end

    def secure?
      # X-Scheme is set by nginx
      # X-FORWARDED-PROTO is set by elastic load balancer
      (req.env['HTTP_X_FORWARDED_PROTO'] == 'https' || req.env['HTTP_X_SCHEME'] == "https")
    end

    def local?
      (LOCAL_HOSTS.member?(req.env['SERVER_NAME']) && (
        req.client_ipaddress == '127.0.0.1' ||
       !req.client_ipaddress.match(/^10\.0\./).nil? ||
       !req.client_ipaddress.match(/^192\.168\./).nil?))
    end

    def json hsh
      res.header['Content-Type'] = "application/json; charset=utf-8"
      res.body = hsh.to_json
    end

    def err *args
      #SYSLOG.err *args
      STDERR.puts *args
    end

    def deny_agents! *agents
      BADAGENTS.flatten.each do |agent|
        if req.user_agent =~ /#{agent}/i
          raise Redirect.new('/')
        end
      end
    end

    def app_path *paths
      paths = paths.flatten.compact
      paths.unshift req.script_name
      paths.join('/').gsub '//', '/'
    end

  end
end


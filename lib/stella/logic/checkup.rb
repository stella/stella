require 'stella/logic'

module Stella::Logic

  class ViewCheckup < Stella::Logic::Base
    attr_reader :checkup, :format
    def raise_concerns(event=:view_checkup)
      raise Stella::NoRun.new(params[:checkid]) if @checkup.nil?
      #check_privacy!
      #return if @cust.colonel? && self.class.colonel_power?
      check_rate_limits! event unless params[:status]  # ajax for reloading page
    end
    protected
    def process_params
      @checkid = params[:checkid] #Stella::Testrun.expand params[:checkid]
      @checkup = Stella::Checkup.first :checkid => @checkid
    end
    def check_privacy!
      if @checkup.testplan.private? && @cust.custid?(@checkup.custid)
        raise Stella::NoRun.new(@checkup.checkid.short)
      end
    end
  end

  class EnableCheckup < Stella::Logic::Base
    attr_reader :checkup, :checkid
    def raise_concerns(event=:view_checkup)
      raise Stella::NoRun.new(params[:checkid]) if checkup.nil?
      check_privacy!
      #return if @cust.colonel? && self.class.colonel_power?
      check_rate_limits! event unless params[:status]  # ajax for reloading page
    end
    def process
      checkup.testplan.enabled = true
      checkup.testplan.save
      if checkup.host.monitored?
        Stella::Analytics.event "Start Page Monitor"
        sess.add_info_message! "Started monitoring #{checkup.testplan.uri}"
      else
        checkup.host.start! :site_basic_v1
        Stella::Analytics.event "Start Monitor"
        sess.add_info_message! "Started monitoring #{checkup.host.hostname}"
      end
    end
    protected
    def process_params
      @checkid = params[:checkid] #Stella::Testrun.expand params[:checkid]
      @checkup = Stella::Checkup.first :checkid => checkid
    end
    def check_privacy!
      raise Stella::NoRun.new(checkup.checkid) if !checkup.customer?(cust)
    end
  end

  class CreateCheckup < Stella::Logic::Base
    attr_reader :uri, :private, :checkup, :testplan, :host
    def raise_concerns(event=:create_checkup)
      unless @uri.port.nil? || cust.paying? || cust.colonel? || (@uri.port == 80 or @uri.port == 443)
        raise Stella::App::Problem.new("You may only check ports 80 and 443")
      end
      raise Stella::App::MissingParam, :uri if params[:uri].to_s.empty?
      check_hostname!   # Even colonels should be prevented from
      #check_privacy!   # running bad hostnames and private tests.
      check_rate_limits! event
    end

    def create
      @host = safedb {
        h = Stella::Host.first(:hostname => Stella::Utils.host(uri), :custid => cust.custid)
        if h.nil?
          h = Stella::Host.new(:hostname => Stella::Utils.host(uri), :custid => cust.custid)
          h.customer = cust
          h.save
        end
        h
      }
      @testplan = Stella::Testplan.first :custid => cust.custid, :uri => uri
      @testplan ||= Stella::Testplan.create :custid => cust.custid, :host => host, :uri => uri, :customer => cust
      if cust.anonymous?
        testplan.definition = {}
        testplan.data = {}
      end
      if params[:auth]
        testplan.data['auth'] = {
          'username' => params[:auth][:username],
          'password' => params[:auth][:password],
        }
      end
      if !cust.anonymous? && host.customer?(cust)
        host.hidden = false
        host.save
        testplan.hidden = false
        testplan.save
      end
      safedb do
        @checkup = Stella::Checkup.new :host => host, :planid => testplan.planid
        checkup.testplan = testplan
        checkup.customer = cust
        #checkup.create_testrun
        checkup.save
        checkup
      end
      Stella::Analytics.event "Run Checkup"
      checkup
    end

    def queue_jobs
      Stella::Job::Checkup.enqueue :checkid => checkup.checkid
      #if testplan.screenshots.empty?
      #  Stella::Job::RenderPlan.enqueue :planid => testplan.planid
      #end
      if host.screenshots.empty?
        Stella::Job::RenderHost.enqueue :hostid => host.hostid
      end
    end

    protected

    def process_params
      @uri = params[:uri].to_s.strip
      @uri = 'http://%s' % [@uri] unless @uri =~ /\Ahttp(s)?:\/\//
      @uri = Stella::Utils.uri @uri
      uri.host ||= ''
      uri.path = '/' if uri.path.nil? || uri.path.empty?
    end

    def check_hostname!
      begin
        is_valid = timeout(5.seconds, TimeoutError) do
          Stella::Utils.valid_hostname?(@uri)
        end
      rescue TimeoutError => ex
        raise Stella::UnknownHostname.new "#{@uri.host} (timeout)"
      end
      raise Stella::UnknownHostname.new @uri.host unless is_valid
      # Stella.config['site.allow_local']
      if @uri.host == '127.0.0.1' || @uri.host == 'localhost' || !@uri.host.match(/^10\.0\./).nil? ||  !@uri.host.match(/^192\.168\./).nil?
        raise Stella::LocalDomainError.new(@uri.host, @cust.custid, @sess[:ipaddress])
      end
      addresses = Stella::Utils.ipaddr(@uri.host) || []
      Stella.ld "[check-hostname] #{@uri.host} -> #{addresses}"
      addresses.each do |ipaddr|
        if Stella::Utils.private_ipaddr?(ipaddr) || Stella::Utils.local_ipaddr?(ipaddr)
          raise Stella::LocalDomainError.new @uri.host, @cust.custid, @sess[:ipaddress]
        end
      end
    end

    def check_privacy!
      Stella.ld "check_privacy: #{testplan.planid.short} #{@cust.custid?(testplan.custid)}"
      if testplan.private? && !@cust.custid?(testplan.custid)
        raise Stella::NoPlan.new(testplan.planid)
      end
    end

  end
end

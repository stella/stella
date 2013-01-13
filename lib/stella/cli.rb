
require 'annoy'
require 'drydock'

class Stella
  class CLI < Drydock::Command

    def init
      Stella.load! :cli
    rescue Redis::CannotConnectError => ex
      Stella.li ex.message
    end

    def resize
      raise Drydock::ArgError if @argv.empty?
      sizes = if @option.width && @option.height
        {:m => [@option.width, @option.height]}
      else
        Stella.config['render.thumbnail.sizes']
      end
      @argv.each do |file|
        sizes.each_pair do |suffix,size|
          width, height = *size
          outfile = Stella::Utils.resize file, width, height, suffix
          puts outfile
        end
      end
    end

    def check_ssl_cert
      require 'net/https'
      uri = Stella::Utils.uri(@argv.first)
      http = Net::HTTP.new(uri.host, 443)
      uri.scheme = 'https'
      http.use_ssl = true
      http.verify_mode = OpenSSL::SSL::VERIFY_PEER
      #http.ca_file = File.join(File.dirname(__FILE__), "cacert.pem")
      http.request_get(uri.path) {|res|
        p res
      }
    rescue OpenSSL::SSL::SSLError, Exception => ex
      puts ex.message
      exit 1
    end

    # stella start-worker
    def start_worker worker_class=Stella::Worker::Remote, *worker_args
      worker_class = Stella::Worker::Local if @option.local
      worker = worker_class.new *worker_args
      if @option.daemon
        #worker.runtime_args = @argv.clone
        worker.daemonize
        worker.run
      else
        worker.run
      end
    end

    def stop_workers worker_class=Stella::Worker
      worker_class.instances.each do |worker|
        kill_worker worker, worker_class
      end
    end

    def stop_worker wid=nil, worker_class=Stella::Worker
      wids = wid ? [wid] : @argv
      wids.each do |wid|
        worker = worker_class.new
        worker.wid = wid
        worker.kill
      end
    end

    def start_timingbelt
      belt_index, belt_count = argv[0].to_i, argv[1].to_i
      belt_index ||= 1
      belt_count ||= 1
      start_worker Stella::Worker::TimingBelt, belt_index, belt_count
    end

    def run_timingbelt
      belt_index, belt_count = argv[0].to_i, argv[1].to_i
      belt_index ||= 1
      belt_count ||= 1
      loop_start = Stella.now
      hosts = Stella::Host.by_timingbelt belt_index, belt_count
      Stella.li "[%d/%d]: %s hosts @ %s" % [belt_index, belt_count, hosts.size, loop_start]
      Stella::Host.schedule hosts, loop_start
    end

    def start_scheduler
      start_worker Stella::Worker::Scheduler
    end

    def first_run
      dirs_needed = []
      ['/var/www/thumbnails',
       '/var/www/public',
       '/var/log/stella',
       '/var/run/stella',
       '/var/lib/stella'].each do |dirpath|
        next if File.directory? dirpath
        dirs_needed << dirpath
      end
      unless dirs_needed.empty?
        Stella.li 'Run the following:'
        Stella.li 'sudo mkdir %s' % [dirs_needed.join(' ')]
        Stella.li 'sudo chown %s %s' % [Stella.sysinfo.user, dirs_needed.join(' ')]
      end
    end

    def redis_flush_scripts
      Stella.redis.script 'flush'
    end

    def redis_load_scripts
      argv.each do |path|
        Stella::RedisObject.load_script path
      end
      Stella.redis_scripts.each_pair { |name,sha| Stella.li "#{name} #{sha}"}
    end

    def redis_start
      conf_path = File.join(Stella::HOME, 'etc', 'redis.conf')
      Stella.li "redis-server #{conf_path}"
      procs = `ps aux`.split($/)
      procs.select! { |line|
        line =~ /redis/ && line !~ /#{@alias}/ && line =~ /#{conf_path}/
      }
      unless procs.empty?
        Stella.li "Redis is already running:"
        Stella.li procs.join($/)
        exit 1
      end
      Kernel.exec "redis-server #{conf_path}"
    end

    def db
      puts Stella.config['db.default.uri']
    end

    def db_recreate
      if Stella.env?(:prod) || Stella.env?(:prod2) || Stella.env?(:production)
        raise "You're messing with production"
      end
      STDERR.puts "Replacing database schema (#{Stella.config['db.default.uri']})"
      if @global.auto || Annoy.are_you_sure?
        if @option.data
          DataMapper::Model.descendants.entries.each do |model|
            Stella.li "Removing #{model} data..."
            model.destroy
          end
        end
        DataMapper.finalize.auto_migrate!
      end
    end

    def db_update
      ## NOTE: IT'S OKAY TO UPDATE THE PRODUCTION DATABASE
      ##if Stella.env?(:prod) || Stella.env?(:prod2) || Stella.env?(:production)
      ##  raise "You're messing with production"
      ##end
      STDERR.puts "Updating database schema (#{Stella.config['db.default.uri']})"
      DataMapper.finalize.auto_upgrade!
    end

    def config
      Stella.li Stella.config.to_yaml
    end

    def email
      email_klass = argv.shift
      raise "No email class provided" unless email_klass
      if @option.all && (@global.auto || Annoy.are_you_sure?)
        customers = Stella::Customer.all
      elsif @option.customer
        customers = [Stella::Customer.first(:email => @option.customer)]
      else
        raise "No customer provided."
      end
      Stella.li "Loaded %d customers" % customers.size
      klass = eval "Stella::Email::#{email_klass}"
      Stella.ld klass
      cnt = 0
      had_errors = []
      customers.each do |cust|
        Stella.ld " -> %s" % cust.email
        begin
          msg = klass.new cust, *argv
          if @option.test
            puts cust.email
            puts msg.subject
            puts msg.render
          else
            msg.send_email
          end
          cnt += 1
        rescue => ex
          had_errors << cust.email
        end
      end
      Stella.li "Sent %d emails" % cnt
      unless had_errors.empty?
        Stella.li "%d were not emailed:" % had_errors.size
        puts had_errors.join(", ")
      end
    end

    def checkup
      uri = argv.first
      sess, cust = Stella::Session.new, Stella::Customer.anonymous
      cust = Stella::Customer.first :email => @option.customer if @option.customer
      raise "Unknown customer: #{@option.customer}" unless cust
      logic = Stella::Logic::CreateCheckup.new(sess, cust, :uri => uri)
      p logic.create
      p logic.queue_jobs
    end

    def testrun
      planid = argv.first
      plan = Stella::Testplan.first :planid => planid
      p Stella::Job::Testrun.enqueue :planid => plan.planid
    end

    def screenshot
      uri = Stella::Utils.uri(argv.first)
      sess, cust = Stella::Session.new, Stella::Customer.anonymous
      cust = Stella::Customer.first :email => @option.customer if @option.customer
      raise "Unknown customer: #{@option.customer}" unless cust
      host = Stella::Host.first_or_create :hostname => uri.host, :custid => cust.custid
      plan = Stella::Testplan.first_or_create :uri => uri.to_s, :custid => cust.custid, :host => host, :hostid => host.hostid
      p Stella::Job::RenderHost.enqueue :hostid => host.hostid
      p Stella::Job::RenderPlan.enqueue :planid => plan.planid
    end

    def load_testplans
      uris = File.readlines(@argv.first)[0..24]
      hosts = {}
      sess, cust = Stella::Session.new, Stella::Customer.anonymous
      uris.each do |uri|
        puts 'Creating %s' % uri
        name = Stella::Utils.host(uri)
        host = (hosts[name] ||= Stella::Host.first_or_create :hostname => name, :customer => cust)
        plan =  Stella::Testplan.first_or_create :custid => cust.custid, :host => host, :uri => uri, :customer => cust
      end
    end

  end
end

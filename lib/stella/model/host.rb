class Stella

  module MetricsCollector
    def rangemetrics
      @rangemetrics ||= Stella::RangeMetrics.new self.class.name, objid
    end
    def add_metrics time, metrics
      rangemetrics.metrics[metrics.to_json] = time.to_i
      # TODO: past_1hour via rangemetrics.range or call LUA script
    end
    def update_stat_summaries interval=1.hour, now=Stella.now
      Stella::RangeMetrics.ranges.each_pair do |rangeid,duration|  # [past_1h, 1.hour]
        if interval.to_i >= duration.to_i
          Stella.ld '[%s/%d]  skipping %s metrics (interval: %d)' % [self.class, self.id, rangeid, interval]
          next
        end
        begin
          keys = [self.rangemetrics.metrics.key]
          argv = [now.to_i, duration, self.rangemetrics.send(rangeid).key]
          cnt = Stella::RangeMetrics.redis.evalsha(Stella.redis_scripts['metrics_calculator'], keys, argv)
          Stella.ld '[%s/%d]  %d items for %s' % [self.class, self.id, cnt, rangeid]
        rescue Redis::CommandError => ex
          Stella.li ex.message
        end
      end
    end
  end

  class Host
    include Stella::MetricsCollector
    alias_method :objid, :hostid
    def normalize
      update_timestamps
      self.hostname ||= Stella::Utils.host(hostname)
      self.hostid ||= gibbler
      self.custid ||= customer.custid if customer
    end
    def start! prodid=nil
      prodid ||= self.product.prodid if self.product
      self.hidden = false
      self.monitored = true
      plans = self.testplans :hidden => false, :order => [ :enabled.desc, :uri ], :limit => 1
      if plans.first && !plans.first.enabled?
        plans.first.enabled = true
        # something here?
        plans.first.save
      elsif plans.empty?
        uri = Stella::Utils.uri(hostname)
        Stella::Testplan.create :host => self, uri => uri, :enabled => true
      end
      normalize
      self.update_product prodid
      self.product.active = true
      save
      Stella::Host.schedule self
    end
    def stop!
      self.monitored = false
      normalize
      self.product.active = false if self.product
      ## don't deschedule. See Host.deschedule comment.
      save
    end
    def destroy!
      self.screenshots.destroy!
      self.contacts.destroy!
      self.checkups.screenshots.destroy!
      self.checkups.destroy!
      self.testruns.destroy!
      self.testplans.screenshots.destroy!
      self.testplans.checkups.screenshots.destroy!
      self.testplans.checkups.destroy!
      self.testplans.testruns.destroy!
      self.testplans.destroy!
      if self.product
        self.product.active = false
        self.product.save
      end
      super
    end
    def customer? cust
      customer == cust
    end
    def shortname
      hostname.shorten(20)
    end
    def screenshot
      @screenshot ||= screenshots.last
    end
    def update_customer cust, with_save=true
      self.custid = cust.custid
      self.customer = cust
      self.save if with_save
    end
    def update_product prodid, with_save=true
      if self.product && self.product.prodid?(prodid)
        # Just enable the current product if the prodid matches
        self.product.active = true
        self.product.save # the old product
      else
        if self.product
          # Deactivate the current product before replacing it.
          self.product.active = false
          self.product.save # the old product
        end
        self.product = Stella::Product.create(customer, prodid)
        self.settings['interval'] = product.options['interval']
        self.save if with_save
      end
      self.product
    end
    @look_ahead = 1.hours # TODO: Stella.config('timingbelt.lookahead') || 1.hour
    class << self
      def destroy! opts={}
        inst = first opts
        inst && inst.destroy!
      end

      def by_timingbelt belt_index, belt_count
        conditions = [ "mod(id, #{belt_count}) = ?", (belt_index-1)]
        Stella::Host.all :monitored => true, :conditions => conditions
      end

      def schedule hosts, start_time=Stella.now
        hosts = [hosts] unless hosts.kind_of?(Array)
        queues = {}
        hosts.each do |host|
          testplans = host.testplans :enabled => true
          Stella.ld " #{host.hostname}: #{testplans.size} plans"
          testplans.each do |plan|
            # Always start on the 5min. We spread all monitored sites across 0-4
            # based on the planid (SHA-1) so we can reliably predict when it runs.
            start_at = start_time.on_the_next(host.settings['interval'])
            # use the proper offset to ensure an even distribution of jobs
            if host.settings['interval'].to_i == 3600
              start_at += (plan.hour_offset || 1).minutes
            elsif host.settings['interval'].to_i == 1800
              start_at += (plan.hour_offset/2 || 1).minutes
            else
              start_at += (plan.minute_offset || 1).minutes
            end
            jobdata = {
              :planid => plan.planid,
              :uri => plan.uri,
              :hostname => host.hostname,
              :offset => plan.minute_offset,
              :interval => host.settings['interval']
            }
            while start_at < (start_time+@look_ahead+host.settings['interval'])
              Stella.ld "  #{plan.uri} @ #{start_at}"
              queue = Stella::SmartQueue.notch start_at, :montreal
              queue.dedupe_field = :planid
              jobdata[:queue] = queue
              queues[queue] ||= []
              queues[queue] << jobdata
              start_at += host.settings['interval']
            end
          end
        end
        queues.each_pair do |queue,jobdata|
          queue.dedupe!(jobdata)
          jobs = jobdata.collect do |data|
            Stella::Job::Testrun.create_job(data)
          end
          Stella.ld " #{queue.key} adding #{jobdata.size} jobs"
          queue.add jobs
        end
        queues
      end

      ##
      ## NOTE: This will onyl work if we look through the redis list for all jobs
      ## over the next @look_ahead period. Removed the testplan IDs from the dedupe
      ## is easy but it means that if the host is enabled right away, we'll end up
      ## creating duplicate jobs.
      ##
      ## Best approach: don't deschedule. Have the workers skip the job if
      ## host.monitored or plan.enabled is false.
      ##
      #def deschedule hosts, start_time=Stella.now
      #  hosts = [hosts] unless hosts.kind_of?(Array)
      #  queues = {}
      #  cnt = 0
      #  hosts.each do |host|
      #    testplans = host.testplans :enabled => true
      #    Stella.ld " #{host.hostname}: #{testplans.size} plans"
      #    testplans.each do |plan|
      #      start_at = start_time.on_the_next(host.settings['interval'])
      #      start_at += (plan.minute_offset || 1).minutes
      #      while start_at < (start_time+@look_ahead+host.settings['interval'])
      #        Stella.ld "  #{plan.uri} @ #{start_at}"
      #        queue = Stella::SmartQueue.notch start_at, :montreal
      #        # Remove the testplan from the dedupe set
      #        cnt += queue.set.delete(plan.planid).to_i
      #      end
      #    end # testplans
      #  end # hosts
      #  cnt
      #end

    end
  end

  class Contact
    alias_method :objid, :contactid
    def gravatar
      Digest::MD5.hexdigest email.downcase if email
    end
    def normalize
      self.contactid ||= gibbler
      update_timestamps
    end
    def customer? cust
      customer == cust
    end
    class << self
      def destroy! opts={}
        inst = first opts
        inst && inst.destroy!
      end
    end
  end

  class Testplan
    include Stella::MetricsCollector
    alias_method :objid, :planid
    def requests
      @requests ||= [Stella::Utils.uri(uri)]
    end
    def customer? cust
      customer == cust
    end
    def update_customer cust
      self.custid = cust.custid
      self.customer = cust
      self.save
    end
    def screenshot
      @screenshot ||= screenshots.last
    end
    def scheme
      parsed_uri.scheme
    end
    def secure?
      scheme == 'https'
    end
    alias_method :secure, :secure?
    def homepage?
      path == '/'
    end
    alias_method :homepage, :homepage?
    def recent_testruns
      testruns.all :created_at.gt => Stella.now-1.day, :order => [:created_at.desc], :limit => 12
    end
    def parsed_uri
      @parsed_uri ||= Stella::Utils.uri(self.uri)
    end
    def path
      parsed_uri.path if parsed_uri
    end
    def shortpath
      path == '/' ? "/ (Homepage)" : path.shorten(18) if path
    end
    def normalize
      update_timestamps
      if host
        self.hostid ||= host.hostid
        self.custid ||= host.customer.custid if host.customer
      end
      self.custid ||= customer.custid if customer
      # We need to set via the accessor so Datamapper includes the
      # planid field in the insert statement (uses changed fields).
      self.planid ||= gibbler
    end
    class << self
      def destroy! opts={}
        inst = first opts
        inst && inst.destroy!
      end
    end
  end

  module HasTestrunSummary
    def parsed_summary
      @parsed_summary ||=
      if self.summary && self.summary['assets']
        s = self.summary
        s['assets'].each do |asset|
          uri = Stella::Utils.uri(asset['uri'])
          asset['scheme'] = uri.scheme
          asset['host'] = uri.host
          asset['host_short'] = uri.host.to_s.shorten(20)
          asset['path'] = uri.path
          asset['path_short'] = uri.path.to_s.shorten(30)
          asset['subdir'] = File.dirname(uri.path.to_s).shorten(30)
        end
        s
      end
      @parsed_summary
    end
  end

  class Checkup
    include HasTestrunSummary
  end

  class Testrun
    include HasTestrunSummary
    alias_method :objid, :runid
    def normalize
      update_timestamps
      self.runid ||= gibbler
      self.salt ||= Stella::Entropy.pop
      if testplan
        self.planid = testplan.planid
        self.hostid = testplan.hostid
        self.custid = testplan.custid
      end
    end
    def customer? cust
      customer == cust
    end
    #def results_cache
    # TODO: STORE FULL RESULTS IN REDIS
    #end
    def status? *guesses
      guesses.flatten.collect(&:to_s).member?(self.status.to_s)
    end
    # Metrics to pull from a testrun summary.
    # key => metric name
    # value (nil) => summary[metric_name]
    # value (String,Symbol) => summary[value] || summary[metric_name]
    # value (Proc) => value.call(summary)
    @metrics = {
      :at => lambda { |summary| Time.parse(summary['started_at']) },
      #:base_uri => 'b',
      :redirect_count => 'redirects',
      :asset_count => nil,
      :error_count => nil,
      :first_request_fb => lambda { |summary|
        summary['first_request']['fb']
      },
      :first_request_rt => lambda { |summary|
        summary['first_request']['rt']
      },
      :first_request_size => lambda { |summary|
        summary['first_request']['size']
      },
      :initial_offset => nil,
      :on_content_ready => 'onContentReady',
      :on_load => 'onLoad',
      :duration => nil,
      :total_size => nil
    }
    def metrics?
      status?(:done) && !(summary.nil? || summary.empty?)
    end
    def metrics
      @metrics ||= {}
      return @metrics if ! @metrics.empty?
      raise Stella::NoMetrics, runid if ! metrics?
      self.class.metrics.each_pair do |m,val|
        @metrics[m] = case val
        when String, Symbol
          summary[val.to_s] || summary[m.to_s]
        when Proc
          #instance_eval(&val)
          val.call(summary)
        else
          summary[m.to_s]
        end
      end
      @metrics
    end
    def started_at
      raise Stella::NoMetrics, runid if ! metrics?
      Time.parse(summary['started_at'])
    end
    class << self
      attr_reader :metrics
      def destroy! opts={}
        inst = first opts
        inst && inst.destroy!
      end
      # NOTE: We use string keys instead of symbols to keep consistent between
      # using the summary right after it's created and loading it from JSON.
      # When an object is deserialize from JSON it uses strings not symbols.
      def parse_har har
        return if har.nil? || har.empty?
        summary = {
          'status' => har['log']['status'],
          'base' => har['log']['pages'][0]['id'],
          'title' => har['log']['pages'][0]['title'],
          'on_content_ready' => har['log']['pages'][0]['pageTimings']['onContentReady'],
          'on_load' => har['log']['pages'][0]['pageTimings']['onLoad'],
          'duration' => har['log']['pages'][0]['pageTimings']['duration'],
          'requests' => har['log']['entries'].size,
          'redirect_count' => 0,
          'asset_count' => 0,
          'error_count' => 0,
          'first_request' => { 'started_at' => nil, 'size' => nil, 'rt' => nil, 'fb' => nil },
          'initial_offset' => nil,
          'total_size' => 0,
          'gaid' => har['log']['gaid']
        }
        if har['log']['pages'][0]['startedDateTime']
          summary['started_at'] = Time.parse(har['log']['pages'][0]['startedDateTime']).to_s  # to normalize format
        end
        if har['log']['pages'][0]['endDateTime']
          summary['ended_at'] = Time.parse(har['log']['pages'][0]['endDateTime']).to_s
        end
        if summary['status'] == 'timeout'
          summary['on_timeout'] = har['log']['pages'][0]['pageTimings']['onTimeout']
        else
          summary['assets'] = har['log']['entries'].collect do |entry|
            summary['total_size'] += entry['response']['bodySize'].to_i
            uri = Stella::Utils.uri(entry['request']['url'])
            uri.path = '[data-uri]' if uri.scheme == "data"
            time = Time.parse(entry['startedDateTime'])
            asset = {
              'meth' => entry['request']['method'],
              'uri' => uri.to_s,
              'code' => entry['response']['status'],
              'size' => entry['response']['bodySize'],
              'rt' => entry['time'],
              'fb' => entry['timings']['wait'],
              'lb' => entry['timings']['receive'],
            }
            if summary['auth_required'].nil? && asset['code'].to_i == 401
              summary['auth_required'] = true
            end
            if summary['first_request']['started_at'].nil?
              case asset['code'].to_i   # skip initial redirects
              when 200...300
                summary['first_request']['started_at'] = time
                summary['first_request']['size'] = asset['size']
                summary['first_request']['rt'] = asset['rt']
                summary['first_request']['fb'] = asset['fb']
              when 300...400
                summary['redirect_count'] += 1
              when 400...600
                summary['error_count'] += 1
              end
            else
              sample = (time.to_f - summary['first_request']['started_at'].to_f)
              asset['offset'] = (sample*1000).to_i # convert back to ms
              # The elapsed time before the first asset is requested
              (summary['initial_offset'] ||= asset['offset']).to_i
              summary['asset_count'] += 1
              case asset['code'].to_i
              when 200...300
              when 300...400
                summary['redirect_count'] += 1
              when 400...600
                summary['error_count'] += 1
              end
            end
            asset
          end
        end
        summary
      end

    end
  end

  class Screenshot
    def filename suffix=:o
      self.objid ||= [self.class, Stella.instance, SecureRandom.uuid].gibbler
      '%s-%s.png' % [objid, suffix]
    end
    def thumbnail
      filename :s
    end
    def stamp
      created_at.strftime('%Y%m%d-%H%M')
    end
    def age
      created_at.to_natural
    end
    class << self
    end
  end

end


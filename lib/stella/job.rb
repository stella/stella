
class Stella
  class Job
    include Stella::RedisObject
    expiration 24.hours
    db 11
    alias_method :jobid, :objid
    def type? guess
      object[:type].to_s == guess.to_s
    end
    def type
      eval object[:type].to_s
    end
    def perform
      type.perform self
    rescue => ex
      # DO THINGS
      Stella.li ex.message
      Stella.li ex.backtrace
      raise ex
    end
    def queue
      @queue ||= Stella::SmartQueue.queues[self[:queue_key]]
    end
    def queue= v
      self[:queue_key] = Stella::SmartQueue === v ? v.key : v
    end
    def redis
      Stella.redis(self.class.db)
    end
    def status! status, msg=nil
      self[:status] = status
      self[:msg] = msg if msg
    end
    class << self
      def create attributes={}
        attributes = {
          :status => :new,
          :created_at => Stella.now.to_i
        }.merge(attributes)
        objid = generate_id attributes.values
        super objid, attributes
      end
      def generate_id *entropy
        entropy << Stella::Entropy.pop
        input = [Stella.instance, Stella.now.to_f, self, entropy].join(':')
        #Stella.ld "#{self} id input: #{input}"
        Gibbler.new input
      end
      def perform_remote job
        klass = eval "#{job['type'].to_s}Remote"
        klass.perform job
      end
    end
  end

  require 'shellwords'
  require 'open3'
  require 'fileutils'
  class Job

    module RenderHost
      extend Stella::Queueable
      def self.perform job
        host = Stella::Host.first :hostid => job[:hostid]
        shot = Stella::Screenshot.new :width => 1024, :height => 768, :host => host
        thumbdir = Stella.config['render.path']
        raise error("Bad hostid #{job[:hostid]}") unless host
        cmd = prepare_command(Stella.config['phantomjs.path'], 'scripts/phantomjs/render.js', host.hostname, shot.width, shot.height)
        Stella.ld cmd
        tmpfile = nil
        Open3.popen3(cmd) {|stdin, stdout, stderr, wait_thr|
          pid = wait_thr.pid # pid of the started process.
          output = stdout.read
          process = wait_thr.value # Process::Status object returned.
          unless process.exitstatus.zero?
            raise error("#{cmd} exited:#{process.exitstatus} (#{output})")
          end
          # Only use the last line of output.
          # NOTE: THIS IS A HACK to get around noisy phantomjs messages (e.g. "TypeError ...")
          output = output.split($/).last
          tmpfile = output
        }
        file = "#{thumbdir}/#{shot.filename}"
        Stella.ld "mv #{tmpfile} #{file}"
        FileUtils.mv tmpfile, file
        cmd = "bin/stella resize #{file}"
        Stella.ld cmd
        Stella.ld `#{cmd}`
        Stella.ld "Updating host (#{host.hostname})"
        Stella::Logic.safedb { shot.save }
        Stella::Logic.safedb { host.screenshots << shot }
        Stella::Logic.safedb { host.save }
      end
    end

    module RenderPlan
      extend Stella::Queueable
      def self.perform job
        plan = Stella::Testplan.first :planid => job[:planid]
        shot = Stella::Screenshot.new :width => 1024, :height => 768, :testplan => plan
        thumbdir = Stella.config['render.path']
        raise error("Bad planid #{job[:planid]}") unless plan
        cmd = prepare_command(Stella.config['phantomjs.path'], 'scripts/phantomjs/render.js', plan.uri, shot.width, shot.height)
        Stella.ld cmd
        tmpfile = nil
        Open3.popen3(cmd) {|stdin, stdout, stderr, wait_thr|
          pid = wait_thr.pid # pid of the started process.
          output = stdout.read
          process = wait_thr.value # Process::Status object returned.
          unless process.exitstatus.zero?
            raise error("#{cmd} exited:#{process.exitstatus} (#{output})")
          end
          # Only use the last line of output.
          # NOTE: THIS IS A HACK to get around noisy phantomjs messages (e.g. "TypeError ...")
          output = output.split($/).last
          tmpfile = output
        }
        file = "#{thumbdir}/#{shot.filename}"
        Stella.ld "mv #{tmpfile} #{file}"
        FileUtils.mv tmpfile, file
        cmd = "bin/stella resize #{file}"
        Stella.ld cmd
        Stella.ld `#{cmd}`
        Stella.ld "Updating plan (#{plan.uri})"
        Stella::Logic.safedb { shot.save }
        Stella::Logic.safedb { plan.screenshots << shot }
        Stella::Logic.safedb { plan.save }
      end
    end

    module Checkup
      extend Stella::Queueable
      def self.perform job
        checkup = Stella::Checkup.first :checkid => job[:checkid]
        raise error("Bad checkid #{job[:checkid]}") unless checkup
        checkup.status = :running
        checkup.save
        plan = checkup.testplan
        options = {
          :width => 1024,
          :height => 768,
          :with_screenshots => true
        }
        options[:gaid] = plan.host.settings['gaid'] if plan.host.settings['disable_ga'].to_s == 'true'
        cmd = prepare_command(Stella.config['phantomjs.path'], 'scripts/phantomjs/testrun.js', plan.requests.first, options.to_json)
        Stella.ld cmd
        report = {}
        Open3.popen3(cmd) {|stdin, stdout, stderr, wait_thr|
          pid = wait_thr.pid # pid of the started process.
          output = stdout.read
          process = wait_thr.value # Process::Status object returned.
          unless process.exitstatus.zero?
            raise error("#{cmd} exited:#{process.exitstatus} (#{output})")
          end
          # Only use the last line of output.
          # NOTE: THIS IS A HACK to get around noisy phantomjs messages (e.g. "TypeError ...")
          output = output.split($/).last
          report = Yajl::Parser.parse(output, :check_utf8 => false)
        }
        checkup.summary = Stella::Testrun.parse_har(report)
        #puts checkup.summary.to_json
        checkup.status = :done

        if checkup.summary['gaid'] #&& checkup.host.settings['gaid'].to_s.empty?
          Stella.ld "Updating google account id"
          checkup.host.settings['gaid'] = checkup.summary['gaid']
          checkup.host.save
        end

        if checkup.summary['total_size']
          Stella::Analytics.event "Bytes In", checkup.summary['total_size']
        end

        screenshot_path = report['log']['screenshot']
        if !screenshot_path.to_s.empty? && File.exists?(screenshot_path)
          shot = Stella::Screenshot.new :testplan => plan
          thumbdir = Stella.config['render.path']
          file = "#{thumbdir}/#{shot.filename}"
          Stella.ld "mv #{screenshot_path} #{file}"
          FileUtils.cp screenshot_path, file
          cmd = "bin/stella resize #{file}"
          Stella.ld cmd
          Stella.ld `#{cmd}`
          Stella::Logic.safedb { shot.save }
          Stella::Logic.safedb { plan.screenshots << shot }
          Stella::Logic.safedb { checkup.screenshots << shot }
        end
        Stella::Logic.safedb { checkup.save  }
      end
    end


    module Testrun
      extend Stella::Queueable
      def self.perform job
        plan = Stella::Testplan.first :planid => job[:planid]
        raise error("Bad planid #{job[:planid]}") unless plan
        raise error("Plan[#{plan.planid}] is disabled") if !plan.enabled
        run = Stella::Testrun.new :testplan => plan, :remote_machine => Stella::RemoteMachine.local, :host => plan.host
        run.status = :running
        Stella::Logic.safedb { run.save }
        options = {
          :width => 1024,
          :height => 768,
          :with_screenshots => false
        }
        options[:gaid] = plan.host.settings['gaid'] if plan.host.settings['disable_ga'].to_s == 'true'
        cmd = prepare_command(Stella.config['phantomjs.path'], 'scripts/phantomjs/testrun.js', plan.requests.first, options.to_json)
        Stella.ld cmd
        har = {}
        Open3.popen3(cmd) {|stdin, stdout, stderr, wait_thr|
          pid = wait_thr.pid # pid of the started process.
          output = stdout.read
          process = wait_thr.value # Process::Status object returned.
          unless process.exitstatus.zero?
            raise error("#{cmd} exited:#{process.exitstatus} (#{output})")
          end
          output = output.split($/).last
          har = Yajl::Parser.parse(output, :check_utf8 => false)
        }
        run.summary = Stella::Testrun.parse_har(har)
        run.result = har
        run.status = :done
        plan.testruns << run
        Stella::Logic.safedb {
          Stella.ld "Updating testrun: #{run.runid}"
          run.save
          Stella.ld "Updating testplan: #{plan.planid}"
          plan.save
        }

        if run.summary['gaid'] #&& plan.host.settings['gaid'].to_s.empty?
          plan.host.settings['gaid'] = run.summary['gaid']
          plan.host.save
        end

        if run.summary['total_size']
          Stella::Analytics.event "Bytes In", run.summary['total_size']
        end

        if run.metrics?
          begin
            plan.add_metrics run.started_at, run.metrics
            plan.host.add_metrics run.started_at, run.metrics
            Stella::RangeMetrics.ranges.each_pair do |rangeid,duration|  # [past_1h, 1.hour]
              if plan.host.settings['interval'].to_i >= duration.to_i
                Stella.li '[%s]  skipping %s metrics (interval: %d)' % [plan.host.hostname, rangeid, plan.host.settings['interval']]
                next
              end
              # plan metrics:
              keys = [plan.rangemetrics.metrics.key]
              argv = [Stella.now.to_i, duration, plan.rangemetrics.send(rangeid).key]
              cnt = Stella.redis.evalsha(Stella.redis_scripts['metrics_calculator'], keys, argv)
              Stella.li '[%s]  %d items for %s' % [plan.planid, cnt, rangeid]
              # host metrics:
              keys = [plan.host.rangemetrics.metrics.key]
              argv = [Stella.now.to_i, duration, plan.host.rangemetrics.send(rangeid).key]
              cnt = Stella.redis.evalsha(Stella.redis_scripts['metrics_calculator'], keys, argv)
              Stella.li '[%s]  %d items for %s' % [plan.host.hostname, cnt, rangeid]
            end
          rescue Redis::CommandError => ex
            Stella.li ex.message
          end
        end
      end
    end

    module TestrunRemote
      extend Stella::Queueable
      def self.perform job
        cmd = prepare_command(Stella.config['phantomjs.path'], 'scripts/phantomjs/testrun.js', job['uri'], job['options'].to_json)
        Stella.li cmd
        result = nil
        Open3.popen3(cmd) {|stdin, stdout, stderr, wait_thr|
          pid = wait_thr.pid # pid of the started process.
          output = stdout.read
          process = wait_thr.value # Process::Status object returned.
          unless process.exitstatus.zero?
            raise error("#{cmd} exited:#{process.exitstatus} (#{output})")
          end
          output = output.split($/).last
          result = Yajl::Parser.parse(output, :check_utf8 => false)
        }
        result
      end
    end

  end
end


Stella::SmartQueue.queue :low
Stella::SmartQueue.queue :high
Stella::SmartQueue.queue :critical
Stella::SmartQueue.queue :low, :montreal
Stella::SmartQueue.queue :high, :montreal
Stella::SmartQueue.queue :critical, :montreal

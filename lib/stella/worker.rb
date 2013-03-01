require 'daemonizable'

class Stella
  class Worker
    include Daemonizable
    MAX_INTERVAL = 300.seconds
    @interval = 30.seconds
    @queuetimeout = 30.seconds
    class << self
      attr_accessor :interval, :queuetimeout
      attr_accessor :region, :nation, :area, :city
      def kname
        name.to_s.downcase.split('::').last
      end
    end
    attr_reader :stat, :pid_file, :opts, :hostname, :started_at
    attr_accessor :interval, :force_exit, :queuetimeout, :workerid
    attr_writer :queue_filter
    def initialize *args
      @hostname = Stella.sysinfo.hostname
      @workerid = [self.class, Stella.sysinfo.to_json, SecureRandom.hex].gibbler #.shorten(20)
      @pid_file ||= "/var/run/stella/#{name}.pid"
      @log_file ||= "/var/log/stella/#{name}.log"
      @interval, @queuetimeout = self.class.interval, self.class.queuetimeout
      @interval_override = nil
      @force_exit = false
      @stat = {
        :jobcount => 0,
        :loopcount => 0
      }
      @started_at = Stella.now
      init *args if respond_to? :init
    end
    # Used by daemonize as the process name (linux only)
    def name
      ['worker', self.class.kname, workerid].flatten.join '-'
    end
    def log msg
      Stella.li msg
    end
    def kill(force=false)
      if force || true
        Stella.li "Destroying #{name}..."
        Worker.kill pid_file, 0 if File.exists?(pid_file) rescue Errno::ESRCH
        File.delete log_file if File.exists?(log_file)
      end
    end
    def interval
      @interval_override || @interval
    end
    def increase_interval
      @interval = 1 if @interval.to_i.zero?
      @interval_override ||= @interval
      @interval_override *= 2 if @interval_override < MAX_INTERVAL
    end
    def reset_interval
      @interval_override = nil
    end
    def uptime
      Stella.now - started_at
    end
    def run
      raise Stella::Problem, "No run defined for #{self.class}"
    end
    def call_online
      debug_line :online
      gracefully_fail { online } if respond_to? :online
    end
    def call_offline
      debug_line :offline
      gracefully_fail { offline  } if respond_to? :offline
    end
    def queue_filter
      @queue_filter ||= [Stella.config['location.city']].compact
      @queue_filter
    end
    def queue_priority
      @queue_priority ||= Stella::SmartQueue.queue_priority queue_filter
      @queue_priority
    end
    def notch_priority now=Stella.now
      @notch_priority ||= Stella::SmartQueue.notch_priority queue_filter, now
      @notch_priority
    end
    def find_job
      return unless jobid = bshift
      job = Stella::Job.load jobid
      raise Stella::Problem, "No such job: #{jobid}" if job.nil?
      job.status! :running
      job
    end
    def bshift
      Stella::SmartQueue.blocking_queue_handler queue_priority.collect(&:key), :blpop
    end
    def bpop
      Stella::SmartQueue.blocking_queue_handler queue_priority.collect(&:key), :brpop
    end
    def shift
      Stella::SmartQueue.blocking_queue_handler queue_priority.collect(&:key), :blpop, 1
    end
    def pop
      Stella::SmartQueue.blocking_queue_handler queue_priority.collect(&:key), :brpop, 1
    end
    private
    def rest
      sleep interval
    end
    def carefully
      begin
        yield
      rescue Interrupt => ex
        Stella.ld "Forcing exit..."
        @force_exit = true
      rescue Stella::Problem => ex
        Stella.lc ex.message
        #STDERR.puts ex.backtrace
      rescue Errno::ECONNREFUSED => ex
        Stella.lc ex.message
        increase_interval
      rescue => ex
        Stella.lc ex.message
        Stella.ld ex.class
        Stella.ld ex.backtrace
        increase_interval
        # TODO: SEND EMAIL OR SOMETHING
      end
    end
    def gracefully_fail msg=nil
      begin
        yield
      rescue Interrupt => ex
        Stella.ld "Forcing exit..."
        @force_exit = true and false
      rescue MultiJson::DecodeError => ex
        Stella.lc (msg || ex.message)
        Stella.ld '%s: %s' % [ex.class, ex.message]
        Stella.ld ex.backtrace
        @force_exit = true and false
      rescue Errno::ECONNREFUSED => ex
        Stella.lc (msg || ex.message)
        @force_exit = true and false
      rescue => ex
        Stella.lc (msg || ex.message)
        Stella.ld '%s: %s' % [ex.class, ex.message]
        Stella.ld ex.backtrace
        # TODO: SEND EMAIL OR SOMETHING
        @force_exit = true and false
      end
    end

    def debug_line meth
      minute_uptime = uptime.in_minutes.to_i
      info = []
      Stella.ld [meth, interval, workerid, stat[:loopcount], minute_uptime, info].inspect
    end

    module SimpleLoop
      def run
        call_online
        while true
          break if @force_exit
          debug_line :workload
          carefully { workload; reset_interval }
          carefully { rest }     # don't let workload exceptions skip this,
          stat[:loopcount] += 1   #      otherwise the loop will go so fast.
          stat[:jobcount] += 1
        end
        call_offline
      end
      def run_once
        call_online
        carefully { workload }
        call_offline
      end
      def workload
        raise Stella::Problem, "No workload defined for #{self.class}"
      end
    end

    module ScheduledLoop
      attr_reader :schedule
      def self.included obj
        def obj.every interval=nil, opts={}, &blk
          @every ||= []
          @every << [interval, opts, blk] unless interval.nil?
          @every
        end
        def every *args
          self.class.every *args
        end
      end
      def run
        require 'eventmachine'
        require 'rufus/scheduler'
        EM.run {
          Signal.trap("INT")  { call_offline; EventMachine.stop }
          Signal.trap("HUP")  { call_offline; EventMachine.stop }
          call_online
          @schedule = Rufus::Scheduler::EmScheduler.start_new
          self.class.every.each do |args|
            interval, opts, blk = *args
            Stella.ld " scheduling every #{interval}s: #{opts}"
            schedule.every interval, opts, &blk
          end
        }
      rescue => ex
        call_offline
        raise ex
      end
    end
  end
end

require 'stella/worker/timingbelt'
require 'stella/worker/scheduler'
require 'stella/worker/local'
require 'stella/worker/remote'

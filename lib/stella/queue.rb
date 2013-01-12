
class Stella

  class SmartQueue
    @queues, @db = {}, 10
    class << self
      attr_reader :queues, :notches, :db, :nowfixed
      def nowfixed=(v)
        return unless Stella.mode?(:tryouts)
        @nowfixed = v
      end
      def queue *parts
        key = SmartQueue === parts.first ? parts.first.key : self.key(*parts)
        (@queues[key] ||= new key)
      end
      def notch at, *parts
        key = SmartQueue === parts.first ? parts.first.key : self.key(stamp(at), *parts)
        @queues[key] ||= new key
      end
      def notches parts=[], now=Stella.now, limit=3
        n = []
        limit.times { |idx| n << Stella::SmartQueue.notch(now-idx.minutes, *parts) } # first offset is 0.
        n.reverse
      end
      def key *parts
        Stella::RedisObject.key :queue, *parts
      end
      def redis
        Stella.redis(db)
      end
      def now mins=0 #, time=nil
        time = nowfixed || Stella.now
        time + (mins*60)  # time wants it in seconds
      end
      def stamp at=self.now
        at = Time.at(at).utc if Numeric === at
        at.strftime('%dd%H%M')
      end
      def queue_priority filter=[], now=Stella.now
        queue_priority = [:critical, :high, :low].collect { |n|
          order = [Stella::SmartQueue.queue( n )]
          filter.inject([]) { |filt,l|
            filt << l
            order << Stella::SmartQueue.queue( n, filt )
            filt
          }
          order.reverse
        }
        [queue_priority].flatten
      end
      def notch_priority filter=[], now=Stella.now, limit=3
        #p [1, filter, now, limit]
        Stella::SmartQueue.notches filter, now, limit
      end
      def pop filter=[], now=Stella.now
        nonblocking_queue_handler queue_priority(filter, now).collect(&:key), :lpop
      end
      def shift filter=[], now=Stella.now
        nonblocking_queue_handler queue_priority(filter, now).collect(&:key), :rpop
      end
      def bshift filter=[], now=Stella.now
        blocking_queue_handler queue_priority(filter, now).collect(&:key), :blpop
      end
      def bpop filter=[], now=Stella.now
        blocking_queue_handler queue_priority(filter, now).collect(&:key), :brpop
      end
      def notch_pop filter=[], now=Stella.now
        nonblocking_queue_handler notch_priority(filter, now).collect(&:key), :lpop
      end
      def notch_shift filter=[], now=Stella.now
        nonblocking_queue_handler notch_priority(filter, now).collect(&:key), :rpop
      end
      def notch_bshift filter=[], now=Stella.now
        blocking_queue_handler notch_priority(filter, now).collect(&:key), :blpop
      end
      def notch_bpop filter=[], now=Stella.now
        blocking_queue_handler notch_priority(filter, now).collect(&:key), :brpop
      end
      # Workers use a blocking pop and will wait for up to
      # Worker.queuetimeout (seconds) before returning nil.
      # Note that the queues are still processed in order.
      # If all queues are empty, the first one to return a
      # value is used. See:
      # http://code.google.com/p/redis/wiki/BlpopCommand
      # +meth+ is either :blpop or :brpop
      def blocking_queue_handler queues, meth, timeout=Stella::Worker.queuetimeout
        queues << timeout  # We do it this way to support Ruby 1.8
        queue, jobid = *(Stella::SmartQueue.redis.send(meth, *queues) || [])
        return nil if jobid.nil?
        #Stella.ld "FOUND #{jobid} in #{queue}"
        jobid
      end
      # Useful in cases where we don't want to block, but
      # we want to pop an item off of one of several queues.
      # For example, we use this to get jobs for remote workers
      # b/c the process serving the API should not block.
      # +meth+ is either :lpop or :rpop
      def nonblocking_queue_handler queues, meth
        jobid, queue = nil, nil
        queues.each do |q|
          queue, jobid = q, Stella::SmartQueue.redis.send(meth, q)
          break if ! jobid.nil?
        end
        return nil if jobid.nil?
        #Stella.ld "FOUND #{jobid} in #{queue}"
        jobid
      end
    end
    attr_reader :list, :key, :parts, :set, :setkey
    attr_accessor :dedupe_field
    def initialize key
      @key, @parts = key, key.split(':')[2..-1]
      @setkey = self.class.key(parts, :dedupe)
      @list = Redis::List.new(key, self.class.redis)
      @set = Redis::Set.new(setkey, self.class.redis)
    end
    def dedupe! hashes
      return hashes unless dedupe_field
      uniques = set.members
      hashes.select! { |hash|
        !uniques.member?(hash[dedupe_field])
      }
    end
    def add jobs
      jobs = [jobs] unless jobs.kind_of?(Array)
      uniques = dedupe_field ? set.members : []
      cnt = 0
      list.redis.pipelined do
        jobs.each { |job|
          if dedupe_field
            next if uniques.member?(job[dedupe_field])
            uniques << job[dedupe_field]
            set.add job[dedupe_field]
          end
          jobid = Stella::Job === job ? job.jobid : job
          list.push(jobid)
          #self.class.redis.echo [list.key, jobid, list.values].inspect
          cnt += 1
        }
      end
      list.expire 48.hours
      set.expire 48.hours
      self
    end
    def clear
      list.clear
      set.clear
    end
  end

  module Queueable
    def enqueue attributes={}
      job = create_job attributes
      Stella.ld "Adding #{job.jobid} (#{self}) to #{job.queue.key}"
      job.queue.add job
      job
    end
    def create_job attributes={}
      queue = Stella::SmartQueue.queue(attributes.delete(:queue) || :high)
      attributes = {
        :type => self, :queue_key => queue.key
      }.merge attributes
      Stella::Job.create attributes
    end
    def prepare_command script, *args
      Shellwords.join [script, *args.flatten.collect(&:to_s)]
    end
    def error msg
      Stella::Problem.new "#{msg} (#{self})"
    end
    class << self
      attr_reader :classes
      def extended obj
        @classes ||= []
        (@classes << obj).uniq!
      end
    end
  end

end



class Stella

  class Worker::TimingBelt < Stella::Worker
    include Stella::Worker::ScheduledLoop
    attr_reader :belt_index, :belt_count
    @interval = 15.minutes

    #
    # +belt_index+ the index within the number of timing belts (e.g. _1_ of 4)
    # +belt_count+ the total number of timing belts
    #
    def init belt_index=1, belt_count=1
      if belt_index > belt_count
        raise ArgumentError, "belt_index cannot be higher than belt_count"
      end
      @belt_index, @belt_count = belt_index.to_i, belt_count.to_i
      if Stella.env?(:prod)
        # Start at a consistent time and stagger eaching timing belt
        @started_at = started_at.on_the_next(interval) + 1.minute*(@belt_index-1)
      end
    end
    # We define tasks in here so that we have access to Stella.config
    # (otherwise it won't have been loaded yet).
    def online
      self.class.every interval, :first_at => Stella.now do
        loop_start = Stella.now
        hosts = Stella::Host.by_timingbelt belt_index, belt_count
        Stella.li "%s [%d/%d]: %s hosts @ %s" % [self.class, belt_index, belt_count, hosts.size, loop_start]
        Stella::Host.schedule hosts, loop_start
      end
    end
    def offline
      if Stella.env?(:prod)
        # TODO:
      end
    end
    private
    def debug_line meth
      minute_uptime = uptime.in_minutes.to_i
      info = [@belt_index, @belt_count]
      Stella.ld [meth, interval, workerid, stat[:loopcount], minute_uptime, info].inspect
    end
  end


end

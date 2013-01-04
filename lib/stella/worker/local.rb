

class Stella

  class Worker::Local < Stella::Worker
    include Stella::Worker::SimpleLoop
    attr_reader :current_job
    @interval = 0.seconds
    @queuetimeout = 3.seconds
    def online
      p :todo_register_worker
    end
    def workload
      @current_job = find_job
      return if current_job.nil?
      Stella.li "[#{current_job.type}] #{current_job.jobid} #{}"
      Stella::Analytics.event "#{current_job.type}"
      current_job.perform
      current_job.status! :done
    rescue => ex
      current_job.status! :error, "#{ex.class}: #{ex.message}" if current_job
      raise ex
    end
    private
    def debug_line meth
      minute_uptime = uptime.in_minutes.to_i
      info = [queuetimeout]
      Stella.ld [meth, interval, workerid, stat[:loopcount], minute_uptime, info].inspect
    end
  end

end

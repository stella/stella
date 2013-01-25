



class Stella

  class Worker::Remote < Stella::Worker
    include Stella::Worker::SimpleLoop
    @interval = 30.seconds
    # TODO: max_uptime, max_runcount
    attr_reader :api
    def online
      gracefully_fail("Initialization error") { Stella.load! }
      custid, apikey = Stella.config['stella.custid'], Stella.config['stella.apikey']
      @api = Stella::API.new custid, apikey, :stella_remote => Stella.config['stella.remote']
      sysinfo = Stella.sysinfo.to_hash
      sysinfo.delete :paths
      opts = { :interval => interval, :sysinfo => sysinfo }
      ret = api.post('worker/register', opts)
      if !ret || !ret[:workerid]
        raise "Could not register worker: %s" % [ret[:msg] || "Unknown error"]
      end
      self.workerid, self.interval = ret[:workerid], ret[:interval]
      Stella.li "Created: #{name} (#{self.class})"
    end
    def workload
      ret = @api.post '/worker/pull', :interval => interval, :workerid => workerid
      ret["jobs"] ||= []
      ret["jobs"].each { |job| handle_job job }
    end
    def handle_job job
      return if force_exit
      begin
        Stella.ld job.to_json
        #result = Timeout.timeout(15.seconds) do
        #  Stella::Job.perform_remote job
        #rescue Timeout::Error
        #  run.status = :timeout
        #  run.save
        #  return
        #end
        result = Stella::Job.perform_remote job
        params = {
          :jobid => job['jobid'],
          :interval => interval,
          :workerid => workerid,
          :continue => true
        }
        # TODO: Upload image to S3 using POST upload policy:
        # http://docs.amazonwebservices.com/AmazonS3/latest/dev/HTTPPOSTExamples.html
        if result['log']
          params[:result] = Zlib::Deflate.deflate(result.to_json)
          #png_path = result['log']['screenshot']
          #if png_path && File.exists?(png_path)
          #  png = Stella::Utils.base64_encode(File.read(png_path))
          #  params[:screenshot] = Zlib::Deflate.deflate(png)
          #end
        end
        ret2 = @api.post '/worker/push', params
        stat[:jobcount] += 1
        ret2["jobs"] ||= []
        ret2["jobs"].each do |job|
          handle_job job
        end
      # This is kind of messy but if it doesn't exit here
      # the process hangs in limbo. If we raise an exception
      # after calling offline, it calls offline several times
      # and hangs after printing "Forcing exit...".
      rescue Interrupt => ex
        @force_exit = true
        call_offline
        exit 1
      end
    end
    def offline
      return if ! @api
      ret = @api.post 'worker/deregister', :workerid => workerid
    end
    private
    def prepare_command script, *args
      Shellwords.join [script, *args.flatten.collect(&:to_s)]
    end
    def debug_line meth
      minute_uptime = uptime.in_minutes.to_i
      info = [Stella::API.base_uri]
      info.push *[@api.custid] if @api
      Stella.ld [meth, interval, workerid, stat[:loopcount], minute_uptime, info].inspect
    end
  end

end

# NOTE: Customer API Keys must be manually created via irb.

# Inspiration:
# http://lcboapi.com/docs/datasets
# http://develop.github.com/

require 'stella/logic'
require 'stella/app/api/base'

class Stella
  class App
    class API

      class Core
        include Stella::App::API::Base

        def status
          publically do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            res.body = content(:status => :nominal)
          end
        end

        def authtest
          authenticated do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            res.body = content(:status => :nominal, :authenticated => sess.authenticated?)
          end
        end

        def self.not_found req, res
          res.header['Content-Type'] = "application/json; charset=utf-8"
          res.status = 404
          res.body = {:code => 404, :msg => "That dynamo cannot be found"}.to_json
        end

        def self.server_error req, res
          res.header['Content-Type'] = "application/json; charset=utf-8"
          res.status = 500
          res.body = {:code => 500, :msg => 'The turbines have failed'}.to_json
        end

      end

      class Checkup
        include Stella::App::API::Base

        def get
          publically do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            checkup = Stella::Checkup.first :checkid => req.params[:checkid]
            return not_found_response("No such checkup") if checkup.nil?
            if req.params[:field]
              res.body = content(:checkid => checkup.checkid, req.params[:field] => checkup.send(req.params[:field]))
            else
              res.body = content(checkup)
            end
          end
        end

      end

      class Worker
        include Stella::App::API::Base

        def register
          authenticated do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            sysinfo = req.params[:sysinfo] || {}
            interval = req.params[:interval].to_i
            interval = interval.zero? ? 30 : interval
            interval = 3 if interval < 3
            interval = 120 if interval > 120
            opts = {
              :custid => cust.custid,
              :hostname => sysinfo[:hostname],
              :ipaddress => req.client_ipaddress
            }
            machine = Stella::RemoteMachine.first opts
            Stella::Logic.safedb { cust.save }
            if machine.nil?
              machine = Stella::RemoteMachine.new :hostname => sysinfo[:hostname],
              :ipaddress => req.client_ipaddress, :customer => cust
              cust.normalize
              cust.save
            end
            opts = {
              :sysinfo => sysinfo,
              :interval => Otto.env?(:dev) ? 3 : 30
            }
            worker = Stella::WorkerProfile.new opts
            worker.remote_machine = machine
            Stella::Logic.safedb { worker.save }
            Stella::Analytics.event "Remote Worker Register"
            if worker.saved?
              res.body = content(:workerid => worker.workerid, :interval => opts[:interval])
            else
              not_found_response "Registration failed"
            end
          end

        end

        def deregister
          authenticated do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            worker = Stella::WorkerProfile.first :workerid => req.params[:workerid]
            if worker.nil?
              not_found_response "No such worker #{req.params[:workerid]}"
            else
              worker.status = :offline
              worker.save
              Stella::Analytics.event "Remote Worker Deregister"
              res.body = content(:workerid => worker.workerid, :status => worker.status)
            end
          end
        end

        # Send a job to a worker
        def pull
          publically do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            worker = Stella::WorkerProfile.first :workerid => req.params[:workerid]
            jobs = self.class.find_jobs([:montreal]) || []
            output = jobs.collect { |job|
              self.class.prepare_job_output(worker, job)
            }
            Stella::Analytics.event "Remote Worker Pull"
            res.body = content(:workerid => worker.workerid, :jobs => output)
          end
        end

        # Receive a finished job from a worker. Optionally, send another.
        def push
          publically do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            worker = Stella::WorkerProfile.first :workerid => req.params[:workerid]
            result = if req.params[:result]
              Hash.from_json(Zlib::Inflate.inflate(req.params[:result]))
            end
            Stella::Analytics.event "Remote Worker Push"
            # p [req.params[:result].to_s.size, req.params[:screenshot].to_s.size]
            job = Stella::Job.load req.params[:jobid]
            if job.nil?
              res.status = 404
              res.body = content(:msg => "Unknown job")
            else
              case job.type.to_s
              when 'Stella::Job::Testrun'
                run = Stella::Testrun.first :runid => job['runid']
                plan = Stella::Testplan.first :planid => job['planid']
                begin
                  run.summary = Stella::Testrun.parse_har(result)
                rescue => ex
                  Stella.li [plan.uri, ex.message].inspect
                  Stella.li ex.backtrace
                end
                if run.summary.nil?
                  run.status = :failed
                elsif run.summary['status'] == 'timeout'
                  run.status = :timeout
                else
                  run.status = :done
                end
                plan.testruns << run
                Stella::Logic.safedb {
                  #Stella.ld "Updating testrun: #{run.runid}"
                  run.save
                  #Stella.ld "Updating testplan: #{plan.planid}"
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
                  interval, now = plan.host.settings['interval'].to_i, Stella.now

                  plan.add_metrics run.started_at, run.metrics
                  plan.update_stat_summaries interval, now

                  plan.host.add_metrics run.started_at, run.metrics
                  plan.host.update_stat_summaries interval, now
                else
                  #Stella.li "no metrics"
                end

              when 'Stella::Job::Checkup'
              else
                p 2
              end
              output = []
              if req.params[:continue].to_s == "true"
                jobs = self.class.find_jobs( [:montreal]) || []
                output = jobs.collect { |job|
                  self.class.prepare_job_output(worker, job)
                }
              end
              res.body = content(:workerid => worker.workerid, :jobs => output, :msg => :thanks!)
            end
          end
        end

        def info
          publically do
            logic = Stella::Logic::Generic.new(sess, cust, req.params)
            logic.raise_concerns(:public_api_get)
            worker = Stella::WorkerProfile.first :workerid => req.params[:workerid]
            if worker.nil?
              not_found_response "No such worker #{req.params[:workerid]}"
            else
              res.body = content(:workerid => worker)
            end
          end
        end

        private
        def self.prepare_job_output worker, job
          info = job.object.all.allow 'hostname', 'type', 'status'
          info['jobid'] = job[:objid]
          case job.type.to_s
          when 'Stella::Job::Testrun'
            plan = Stella::Testplan.first :planid => job['planid']
            raise Stella::Problem, ("Bad planid #{job['planid']}") unless plan
            raise Stella::Problem, ("Plan[#{plan.planid}] is disabled") if !plan.enabled
            run = Stella::Testrun.new :testplan => plan,
                                          :remote_machine => Stella::RemoteMachine.local,
                                          :host => plan.host,
                                          :status => :running
            Stella::Logic.safedb { run.save }
            job['runid'] = run.runid
            info['uri'] = plan.requests.first
            info['options'] = {
              :width => 1024,
              :height => 768,
              :with_screenshots => false
            }
            if plan.data['auth']
              info['options']['username'] = plan.data['auth']['username']
              info['options']['password'] = plan.data['auth']['password']
            end
            if plan.host.settings['disable_ga'].to_s == 'true'
              info['options']['gaid'] = plan.host.settings['gaid']
            end
          when 'Stella::Job::Checkup'
            raise job.type
          else
            raise job.type
          end
          info
        end
        def self.find_job filter
          now = Time.parse('2012-12-18 10:18:39 UTC')
          #p [filter, now]
          #p Stella::SmartQueue.notch_priority(filter, now).collect(&:key)
          jobid = Stella::SmartQueue.notch_pop(filter)
          job = Stella::Job.load jobid if ! jobid.nil?
        end
        def self.find_jobs filter
          job = find_job filter
          jobs = job.nil? ? [] : [job]
        end
      end

    end
  end
end

    # https://github.com/rack/rack/blob/master/lib/rack/auth/basic.rb
    # def protected!
    #   unless authorized?
    #     response['WWW-Authenticate'] = %(Basic realm="Restricted Area")
    #     throw(:halt, [401, "Not authorized\n"])
    #   end
    # end

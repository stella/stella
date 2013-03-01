

class Stella
  class Worker::Scheduler < Stella::Worker
    include Stella::Worker::ScheduledLoop
    def online
      p :todo_scheduler_online
    end
    def offline
      p :todo_scheduler_offline
    end
    every 1.minute, :first_at => Stella.now do |*args|
      current_incidents = Stella::Incident.all :status => :detected
      Stella.li '[detected-incidents] %d @ %d' % [current_incidents.size, Stella.now.min]
      current_incidents.each { |dent|
        Stella.li " [#{dent.testplan.planid}/#{dent.dentid}]"
        if dent.data['scheduled']
          Stella.ld "  already scheduled"
          if dent.detected_age > 5.minutes
            Stella.li "  assumed resolved"
            dent.resolved!
          end
        else
          job = dent.enqueue_checkups
          Stella.ld "  scheduled #{job.jobid}"
          dent.data['scheduled'] = true
          dent.save
        end
      }
    end
    every 1.hour do |args|

    end
    every 24.hours do
      # cleanup some db stuff
    end
    every 60.seconds do
      #
    end
  end
end

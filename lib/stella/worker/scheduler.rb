

class Stella
  class Worker::Scheduler < Stella::Worker
    include Stella::Worker::ScheduledLoop
    def online
    end
    def offline
    end
    every 1.minute, :first_at => Stella.now do |*args|
      detected_incidents = Stella::Incident.all :status => :detected
      Stella.li '[detected-incidents] %d @ %s' % [detected_incidents.size, Stella.now]
      detected_incidents.each { |dent|
        Stella.li " [#{dent.testplan.planid}/#{dent.dentid}] #{dent.detected_age.in_minutes}m old"
        to_schedule = false
        if dent.data['scheduled']
          if dent.detected_age > 20.minutes
            Stella.li "  assumed resolved"
            dent.resolved!
          elsif dent.detected_age > 10.minutes && dent.detected_age < 12.minutes  # give the checkup a second chance
            to_schedule = true
          end
        else
          to_schedule = true
        end

        if to_schedule
          job = dent.enqueue_checkups
          Stella.li "  scheduled #{job.jobid}"
          dent.data['scheduled'] = Stella.now
          dent.save
        end
      }

      verified_incidents = Stella::Incident.all :status => :verified
      Stella.li '[verified-incidents] %d @ %s' % [verified_incidents.size, Stella.now]
      verified_incidents.each { |dent|
        Stella.li " [#{dent.testplan.planid}/#{dent.dentid}] testruns:#{dent.testruns.size} #{dent.verified_age.in_minutes}m old"
        if dent.verified_age > 24.hours
          Stella.li "  assumed resolved"
          dent.resolved!
        end
      }
    end
    every 1.hour do |args|

    end
    every 24.hours do
      # cleanup some db stuff
    end
  end
end

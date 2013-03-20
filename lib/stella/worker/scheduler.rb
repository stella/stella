

class Stella
  class Worker::Scheduler < Stella::Worker
    include Stella::Worker::ScheduledLoop
    def online
    end
    def offline
    end
    every 1.minute, :first_at => Stella.now do |*args|
      Stella::Incident.handle_detected_incidents
      Stella::Incident.handle_verified_incidents
    end
    every 1.hour do |args|
    end
    every 24.hours do
      # cleanup some db stuff
    end
  end
end

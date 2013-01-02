

class Stella
  class Worker::Scheduler < Stella::Worker
    include Stella::Worker::ScheduledLoop
    def online
      p :todo_scheduler_online
      cust = Stella::Customer.find :email => 'delano@blamestella.com'
      p cust
      p [Stella::DailyUsage.daily_bill(cust.monthly_bill), cust.monthly_bill, cust.active_products]
    end
    def offline
      p :todo_scheduler_offline
    end
    every 1.minute, :first_at => Stella.now do |*args|
      # check some bullshit
      #p [1, self, args]
      customers = Stella::Customer.all :hour_offset => Stella.now.min
      Stella.li '%d @ %d' % [customers.size, Stella.now.min]
      customers.each { |cust|
        #Stella.li " #{cust.email} #{cust.monthly_bill}"
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

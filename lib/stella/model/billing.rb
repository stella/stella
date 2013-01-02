

class Stella
  class BillingStatement
  end
  class DailyUsage
    def self.days_in_month(year, month)
      (Date.new(year, 12, 31) << (12-month)).day
    end
    def self.days_this_month
      n = Stella.now
      days_in_month n.year, n.mon
    end
    def self.daily_bill amount
      (amount/days_this_month.to_f).round(4)
    end
  end
end

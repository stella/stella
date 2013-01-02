require 'stella'

Stella.debug = false
Stella.load! :tryouts

@days =[nil, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

## Days in Feb 1900
Stella::DailyUsage.days_in_month 1900, 2
#=> 28

## Days in Feb 2000
Stella::DailyUsage.days_in_month 2000, 2
#=> 29

## Days in Feb 2012
Stella::DailyUsage.days_in_month 2012, 2
#=> 29

## Days in Feb 2013
Stella::DailyUsage.days_in_month 2013, 2
#=> 28

## Days in Aug 2013
Stella::DailyUsage.days_in_month 2013, 8
#=> 31

## Days in Feb 2016
Stella::DailyUsage.days_in_month 2016, 2
#=> 29

## Days in Feb 2100
Stella::DailyUsage.days_in_month 2100, 2
#=> 28

## Days this month (will fail in February on a leap year)
Stella::DailyUsage.days_this_month
#=> @days[Stella.now.mon]

## Daily bill for $12/month
Stella::DailyUsage.daily_bill 12
#=> 0.3871

## Daily bill for $0 - $10
bill = []
11.times { |i| bill << Stella::DailyUsage.daily_bill(i) }
bill
#=> [0.0, 0.0323, 0.0645, 0.0968, 0.129, 0.1613, 0.1935, 0.2258, 0.2581, 0.2903, 0.3226]

## Daily bill for $11 - $20
bill = []
10.times { |i| bill << Stella::DailyUsage.daily_bill(i+11) }
bill
#=> [0.3548, 0.3871, 0.4194, 0.4516, 0.4839, 0.5161, 0.5484, 0.5806, 0.6129, 0.6452]

## Daily bill for $21 - $30
bill = []
10.times { |i| bill << Stella::DailyUsage.daily_bill(i+21) }
bill
#=> [0.6774, 0.7097, 0.7419, 0.7742, 0.8065, 0.8387, 0.871, 0.9032, 0.9355, 0.9677]

## Daily bill for $31 - $40
bill = []
10.times { |i| bill << Stella::DailyUsage.daily_bill(i+31) }
bill
#=> [1.0, 1.0323, 1.0645, 1.0968, 1.129, 1.1613, 1.1935, 1.2258, 1.2581, 1.2903]

## Daily bill for $100 - $200
bill = []
100.times { |i| bill << Stella::DailyUsage.daily_bill(i+101) }
bill
#=> [3.2581, 3.2903, 3.3226, 3.3548, 3.3871, 3.4194, 3.4516, 3.4839, 3.5161, 3.5484, 3.5806, 3.6129, 3.6452, 3.6774, 3.7097, 3.7419, 3.7742, 3.8065, 3.8387, 3.871, 3.9032, 3.9355, 3.9677, 4.0, 4.0323, 4.0645, 4.0968, 4.129, 4.1613, 4.1935, 4.2258, 4.2581, 4.2903, 4.3226, 4.3548, 4.3871, 4.4194, 4.4516, 4.4839, 4.5161, 4.5484, 4.5806, 4.6129, 4.6452, 4.6774, 4.7097, 4.7419, 4.7742, 4.8065, 4.8387, 4.871, 4.9032, 4.9355, 4.9677, 5.0, 5.0323, 5.0645, 5.0968, 5.129, 5.1613, 5.1935, 5.2258, 5.2581, 5.2903, 5.3226, 5.3548, 5.3871, 5.4194, 5.4516, 5.4839, 5.5161, 5.5484, 5.5806, 5.6129, 5.6452, 5.6774, 5.7097, 5.7419, 5.7742, 5.8065, 5.8387, 5.871, 5.9032, 5.9355, 5.9677, 6.0, 6.0323, 6.0645, 6.0968, 6.129, 6.1613, 6.1935, 6.2258, 6.2581, 6.2903, 6.3226, 6.3548, 6.3871, 6.4194, 6.4516]



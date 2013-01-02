
require 'time'
require 'stella/core_ext'

@now = Time.parse('2012-05-08 23:36:17 UTC')
@hash = {
  :a => 9,
  :b => 8,
  :c => 7,
  :d => 6,
  :e => 5
}

## Hash.except
@hash.except :a, :e
#=> {:b=>8, :c=>7, :d=>6}

## Hash.allow
@hash.allow :b, :d
#=> {:b=>8, :d=>6}

## Time#quantize 1 min
@now.quantize( 1.minutes).to_s
#=> '2012-05-08 23:36:00 UTC'

## Time#quantize 5min
@now.quantize(5.minutes).to_s
#=> '2012-05-08 23:35:00 UTC'

## Time#quantize 30min
@now.quantize(30.minutes).to_s
#=> '2012-05-08 23:30:00 UTC'

## Time#quantize 1hour
@now.quantize(1.hour).to_s
#=> '2012-05-08 23:00:00 UTC'

## Time#quantize 4hours
@now.quantize(4.hours).to_s
#=> '2012-05-08 20:00:00 UTC'

## Time#quantize 1day
@now.quantize(1.day).to_s
#=> '2012-05-08 00:00:00 UTC'

## Time#quantize 1day
@now.quantize(1.day).to_s
#=> '2012-05-08 00:00:00 UTC'

## Time#quantized_range
yesterday = @now-1.day
range = @now.quantized_range(4.hours, yesterday)
range.collect { |t| t.to_s }
#=> ["2012-05-07 20:00:00 UTC", "2012-05-08 00:00:00 UTC", "2012-05-08 04:00:00 UTC", "2012-05-08 08:00:00 UTC", "2012-05-08 12:00:00 UTC", "2012-05-08 16:00:00 UTC", "2012-05-08 20:00:00 UTC"]

## Time#quantized_range always returns from oldest to newest
yesterday = @now-1.day
range = yesterday.quantized_range(4.hours, @now)
range.collect { |t| t.to_s }
#=> ["2012-05-07 20:00:00 UTC", "2012-05-08 00:00:00 UTC", "2012-05-08 04:00:00 UTC", "2012-05-08 08:00:00 UTC", "2012-05-08 12:00:00 UTC", "2012-05-08 16:00:00 UTC", "2012-05-08 20:00:00 UTC"]

## Integer#quantized_range
yesterday = @now.to_i-1.day
range = @now.to_i.quantized_range(4.hours, yesterday)
#=> [1336420800, 1336435200, 1336449600, 1336464000, 1336478400, 1336492800, 1336507200]

## Integer#quantized_range always returns from oldest to newest
yesterday = @now.to_i-1.day
range = yesterday.quantized_range(4.hours, @now.to_i)
#=> [1336420800, 1336435200, 1336449600, 1336464000, 1336478400, 1336492800, 1336507200]

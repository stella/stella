require 'stella'

Stella.debug = false
Stella.load! :tryouts

@now = Time.parse('2012-05-08 23:26:17 UTC')

## Config has StatHat user
Stella.config['vendor.stathat.user'].to_s.empty?
#=> false

## Can add a count
Stella::Analytics.stathat_count 'tryouts-count', 2
#=> true

## Can add a value
Stella::Analytics.stathat_value 'tryouts-value', rand*10000
#=> true

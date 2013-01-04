require 'stella'

Stella.debug = false
Stella.load! :tryouts

@now = Time.parse('2012-05-08 23:26:17 UTC')

## Config has StatHat user
Stella.config['vendor.stathat.user'].to_s.empty?
#=> false

## Can add a count directly
Stella::Analytics::StatHat.count 'tryouts-count', 2
#=> true

## Can add a value directly
Stella::Analytics::StatHat.value 'tryouts-value', rand*10000
#=> true

## Stella::Analytics.event knows to use stathat
Stella::Analytics.event 'tryouts-count', 2
#=> true

## Stella::Analytics.value knows to use stathat
Stella::Analytics.value 'tryouts-value', rand*10000
#=> true

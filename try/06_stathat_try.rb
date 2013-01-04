require 'stella'

Stella.debug = false
Stella.load! :tryouts

@now = Time.parse('2012-05-08 23:26:17 UTC')

## Config has StatHat user
Stella.config['vendor.stathat.user'].to_s.empty?
#=> false

## Can add a count
StatHat::API.ez_post_count('tryouts-count', Stella.config['vendor.stathat.user'], 5)
#=> true

## Can add a value
StatHat::API.ez_post_value('tryouts-value', Stella.config['vendor.stathat.user'], (rand*1000))
#=> true

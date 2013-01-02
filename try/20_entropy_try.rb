require 'stella'

Stella.load! :tryouts

## Can get key name
Stella::Entropy.values.key
#=> 'v3:stella:entropy'

## Can clear
Stella::Entropy.clear
#=> 0

## Is empty
Stella::Entropy.size
#=> 0

## Has failover
Stella::Entropy.failover.size
#=> 6

## pop always has a value
Stella::Entropy.clear
Stella::Entropy.pop.size
#=> 6

## Can populate
Stella::Entropy.populate 5
#=> 5
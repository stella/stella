require 'stella'
#Stella.debug = true

Stella.load! :tryouts

## Tryouts session doesn't exist
Stella::Session.exists? :TRYOUTSSESSID
#=> false

## Can set redis
Stella::Session.redis.client.db
#=> 1

## Can set prefix
Stella::Session.redis_prefix
#=> 'v3:session'

# Has index
Stella::Session.has_index?
#=> true

## Knows fields
Stella::Session.fields
#=> [:desc, :error_messages, :info_messages, :object, :request_params, :vars]

## Can initialize
sess = Stella::Session.new
sess.class
#=> Stella::Session

## Knows keys
sess = Stella::Session.new 'obj1'
sess.desc = "nothing"
sess[:poop] = 'truck'
sess[:poop]
sess.keys
#=> ["v3:session:obj1:desc", "v3:session:obj1:error_messages", "v3:session:obj1:info_messages", "v3:session:obj1:object", "v3:session:obj1:request_params", "v3:session:obj1:vars"]

## Session IDs are unique
sessid1 = Stella::Session.generate_id '127.0.0.1', :tryouts
sessid2 = Stella::Session.generate_id '127.0.0.1', :tryouts
sessid1 != sessid2
#=> true

## Can set a value
@sess1 = Stella::Session.new 'obj1'
@sess1[:poop] = 'truck'
@sess1[:poop]
#=> 'truck'

## Has time stamps
@sess2 = Stella::Session.create '127.0.0.1', 'user agent', :created_at => 1334250203.828583
@sess2.updated! 1334250203.8287418
ret = [@sess2.created_at, @sess2.updated_at]
#=> [1334250203.828583, 1334250203.8287418]

## Has expiration
@sess3 = Stella::Session.create '127.0.0.1', 'user agent'
[Stella::Session.expiration, @sess3.ttl]
#=> [1800, 1800]

## Can update expiration
@sess3.update_expiration 30.days
@sess3.ttl
#=> 2592000

## Has shrimp
@sess4 = Stella::Session.create '127.0.0.1', 'user agent'
@sess4.add_shrimp == @sess4.add_shrimp
#=> true

@sess1.destroy! :all
@sess2.destroy! :all
@sess3.destroy! :all

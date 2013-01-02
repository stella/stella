require 'stella'

#Stella.debug = true
Stella.load! :tryouts

## Check status
@api = Stella::API.new 
@api.get '/status'
#=> {"status"=>"nominal"}

## Check authtest
@api.get '/authtest'
#=> {"status"=>"nominal", "authenticated"=>true}

## Check authtest failure
api = Stella::API.new 'bogus', 'bogus'
api.get '/authtest'
#=> {"code"=>404, "msg"=>"Not authorized"}

## Run a checkup
@api.post '/checkup'
#=> {"status"=>"nominal", "authenticated"=>true}

## Get checkup status
@api.get '/checkup/%s' % [checkid]
#=> {"status"=>"nominal", "authenticated"=>true}


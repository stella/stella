require 'stella'

Stella.load! :tryouts


## Generate string id
Stella::Utils.sid 'stella'
#=> 'd7463eb2fa0eee3f69a0a043cfbc19578b95cd9f'

## Time chunks
Stella::Utils.time_chunks
#=> true

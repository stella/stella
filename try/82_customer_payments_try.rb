require 'stella'

require 'spreedly-core-ruby'
require 'spreedly-core-ruby/test_extensions'

# SpreedlyCore::Base.debug_output $stdout

Stella.load! :tryouts

@key = Stella.config['vendor.spreedlycore.key']
@secret = Stella.config['vendor.spreedlycore.secret']
@gateway = Stella.config['vendor.spreedlycore.testgateway']
SpreedlyCore.configure(@key, @secret, @gateway)


## Can configure SpreedlyCore
[SpreedlyCore::Base.login, SpreedlyCore::Base.gateway_token]
#=> [@key, @gateway]
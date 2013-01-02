# require 'httparty'

# class Stella
#   module Vendors

#     class SendGrid
#       include HTTParty
#       base_uri 'https://sendgrid.com/api/'
#       #debug_output $stdout
#       #ssl_ca_file Stella::Client::SSL_CERT_PATH

#       class << self
#         def config
#           {
#             :from => Stella.config['account.tech.email'],
#             :fromname => Stella.config['account.tech.name'],
#             :api_user => Stella.config['vendor.sendgrid.api_user'],
#             :api_key => Stella.config['vendor.sendgrid.api_key']

#           }
#         end
#         def send to, subject, text, bcc=nil, category=nil
#           category ||= "incident"
#           # NOTE: The heading setting below has no effect
#           options = {
#             :to => to,
#             :subject => subject,
#             :html => text,
#             'x-smtpapi' => { :'category' => category, :machine => Stella.sysinfo.hostname }.to_json,
#           }.merge(config)
#           options[:bcc] = bcc unless bcc.to_s.empty?
#           res = post("/mail.send.json", :body => options)
#           res.response.code_type == Net::HTTPOK
#         end
#         # https://sendgrid.com/api/?
#         #   api_user=youremail@domain.com
#         #   api_key=secureSecret
#         #   to=destination@example.com
#         #   toname=Destination
#         #   subject=Example%20Subject
#         #   text=testingtextbody
#         #   from=info@domain.com
#         #
#       end
#     end

#   end
# end

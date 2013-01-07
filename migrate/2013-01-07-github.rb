# 2013-01-07
# * Add github_token to Customer

# ruby -Ilib -rstella migrate/2013-01-07-github.rb [UP|DOWN]

require 'dm-migrations'
require 'dm-migrations/migration_runner'

begin

  Stella.load_db

  migration 1, :add_github_token_to_customer do
    up do
      modify_table :stella_customers do
        add_column :github_token, String, :size => 64, :unique_index => true
      end
    end
    down do
      modify_table :stella_customers do
        drop_column :github_token
      end
    end
  end

  case ARGV.first.to_s.upcase
  when "DOWN"
    migrate_down!
  when "UP"
    migrate_up!
  else
    Stella.li "Skipping"
  end

rescue => ex
  puts "#{ex.class} #{ex.message}", ex.backtrace
  exit 1
end

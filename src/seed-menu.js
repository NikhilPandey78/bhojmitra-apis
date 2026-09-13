import { Pool } from 'pg';

const pool = new Pool({ connectionString: 'postgresql://bhojmitra:Nikhil%401@localhost:5432/bhojmitra' });

export const MENU_ITEMS_CATALOG = [
  // Starters
  { name: 'Paneer Tikka', category: 'Starters', price: 240, cost: 85, is_veg: true, desc: 'Marinated cottage cheese cubes grilled with capsicum and onions in tandoor.' },
  { name: 'Crispy Corn Salt & Pepper', category: 'Starters', price: 180, cost: 55, is_veg: true, desc: 'Sweet corn kernels fried crisp and tossed with herbs & crushed black pepper.' },
  { name: 'Veg Spring Rolls', category: 'Starters', price: 160, cost: 50, is_veg: true, desc: 'Crunchy rolls stuffed with seasoned wok-tossed garden vegetables.' },
  { name: 'Hara Bhara Kabab', category: 'Starters', price: 190, cost: 60, is_veg: true, desc: 'Spinach, green pea and potato patties spiced with aromatic herbs.' },
  { name: 'Dahi Ke Kabab', category: 'Starters', price: 220, cost: 75, is_veg: true, desc: 'Melt-in-mouth hung curd patties seasoned with roasted spices & coriander.' },
  { name: 'Soya Malai Chaap Tikka', category: 'Starters', price: 230, cost: 70, is_veg: true, desc: 'Tender soya chaap roasted in creamy cashew tandoori marination.' },
  { name: 'Chicken Tikka', category: 'Starters', price: 280, cost: 110, is_veg: false, desc: 'Succulent boneless chicken chunks marinated in rich tandoori spices.' },
  { name: 'Tandoori Chicken (Half)', category: 'Starters', price: 290, cost: 120, is_veg: false, desc: 'Classic bone-in whole chicken grilled to smoky perfection in clay oven.' },
  { name: 'Chilli Paneer (Dry)', category: 'Starters', price: 220, cost: 75, is_veg: true, desc: 'Cottage cheese cubes tossed in spicy Indo-Chinese chilli garlic sauce.' },
  { name: 'Veg Manchurian (Dry)', category: 'Starters', price: 180, cost: 55, is_veg: true, desc: 'Golden vegetable balls tossed in savoury garlic soya sauce.' },

  // Main Course (Veg)
  { name: 'Paneer Butter Masala', category: 'Main Course', price: 260, cost: 90, is_veg: true, desc: 'Soft paneer cubes simmered in rich creamy tomato butter gravy.' },
  { name: 'Dal Makhani', category: 'Main Course', price: 220, cost: 65, is_veg: true, desc: 'Slow-cooked black lentils simmered overnight with white butter & cream.' },
  { name: 'Shahi Paneer', category: 'Main Course', price: 270, cost: 95, is_veg: true, desc: 'Royal cottage cheese preparation in sweet & spicy cashew nut gravy.' },
  { name: 'Kadhai Paneer', category: 'Main Course', price: 250, cost: 85, is_veg: true, desc: 'Paneer tossed with bell peppers, onions and freshly crushed coriander seeds.' },
  { name: 'Dal Tadka', category: 'Main Course', price: 160, cost: 45, is_veg: true, desc: 'Yellow lentils tempered with desi ghee, cumin seeds, garlic & red chillies.' },
  { name: 'Malai Kofta', category: 'Main Course', price: 260, cost: 90, is_veg: true, desc: 'Stuffed cottage cheese dumplings in velvety saffron & cashew nut gravy.' },
  { name: 'Mix Veg Handi', category: 'Main Course', price: 210, cost: 65, is_veg: true, desc: 'Seasonal fresh vegetables cooked with whole spices in clay handi.' },
  { name: 'Palak Paneer', category: 'Main Course', price: 230, cost: 75, is_veg: true, desc: 'Fresh spinach puree gravy cooked with garlic, cream and soft paneer.' },
  { name: 'Mushroom Do Pyaza', category: 'Main Course', price: 240, cost: 80, is_veg: true, desc: 'Fresh button mushrooms sauteed with abundant onions and spices.' },
  { name: 'Chana Masala', category: 'Main Course', price: 180, cost: 55, is_veg: true, desc: 'Traditional Punjabi chickpeas cooked in spicy onion tomato gravy.' },

  // Main Course (Non-Veg)
  { name: 'Butter Chicken', category: 'Main Course', price: 340, cost: 130, is_veg: false, desc: 'Tandoori chicken chunks in rich makhani tomato butter gravy.' },
  { name: 'Kadhai Chicken', category: 'Main Course', price: 320, cost: 120, is_veg: false, desc: 'Chicken cooked with whole ground spices, capsicum and thick gravy.' },
  { name: 'Chicken Curry (Homestyle)', category: 'Main Course', price: 290, cost: 110, is_veg: false, desc: 'Traditional tender chicken in rustic onion-tomato home-style gravy.' },
  { name: 'Mutton Rogan Josh', category: 'Main Course', price: 420, cost: 170, is_veg: false, desc: 'Kashmiri specialty slow-cooked tender goat meat in rich aromatic gravy.' },
  { name: 'Egg Curry (2 Eggs)', category: 'Main Course', price: 190, cost: 60, is_veg: false, desc: 'Boiled eggs simmered in rich spiced onion-tomato masala gravy.' },

  // Biryani & Rice
  { name: 'Hyderabadi Dum Veg Biryani', category: 'Biryani', price: 220, cost: 70, is_veg: true, desc: 'Fragrant basmati rice layered with vegetables, saffron, mint & fried onions.' },
  { name: 'Chicken Dum Biryani', category: 'Biryani', price: 290, cost: 105, is_veg: false, desc: 'Authentic Hyderabadi spiced chicken layered with long-grain basmati rice.' },
  { name: 'Mutton Dum Biryani', category: 'Biryani', price: 390, cost: 160, is_veg: false, desc: 'Slow-cooked tender mutton pieces with royal aromatic basmati rice & raita.' },
  { name: 'Jeera Rice', category: 'Biryani', price: 120, cost: 35, is_veg: true, desc: 'Premium basmati rice tempered with roasted cumin seeds and desi ghee.' },
  { name: 'Steamed Basmati Rice', category: 'Biryani', price: 90, cost: 25, is_veg: true, desc: 'Fluffy long-grain steamed white basmati rice.' },
  { name: 'Veg Fried Rice', category: 'Biryani', price: 170, cost: 50, is_veg: true, desc: 'Wok-tossed rice with crunchy vegetables and oriental seasoning.' },

  // Breads & Tandoor
  { name: 'Butter Naan', category: 'Breads', price: 45, cost: 12, is_veg: true, desc: 'Leavened clay oven flatbread brushed generously with melted butter.' },
  { name: 'Garlic Naan', category: 'Breads', price: 60, cost: 16, is_veg: true, desc: 'Tandoori naan topped with roasted minced garlic and fresh coriander.' },
  { name: 'Tandoori Roti (Plain)', category: 'Breads', price: 18, cost: 5, is_veg: true, desc: 'Whole wheat flatbread baked freshly in clay tandoor oven.' },
  { name: 'Butter Tandoori Roti', category: 'Breads', price: 22, cost: 7, is_veg: true, desc: 'Whole wheat tandoori roti brushed with melted butter.' },
  { name: 'Laccha Paratha', category: 'Breads', price: 50, cost: 14, is_veg: true, desc: 'Multi-layered crispy and flaky whole wheat paratha baked in tandoor.' },
  { name: 'Stuffed Paneer Kulcha', category: 'Breads', price: 80, cost: 24, is_veg: true, desc: 'Soft refined flour bread stuffed with spicy cottage cheese filling.' },
  { name: 'Missi Roti', category: 'Breads', price: 35, cost: 10, is_veg: true, desc: 'Gram flour (besan) and wheat flatbread with onion, ajwain & spices.' },

  // South Indian
  { name: 'Masala Dosa', category: 'South Indian', price: 140, cost: 40, is_veg: true, desc: 'Golden crispy crepe filled with spiced potato masala, served with sambar & chutneys.' },
  { name: 'Plain Dosa', category: 'South Indian', price: 100, cost: 28, is_veg: true, desc: 'Crispy golden rice & lentil crepe with fresh coconut chutney & piping hot sambar.' },
  { name: 'Cheese Butter Masala Dosa', category: 'South Indian', price: 180, cost: 60, is_veg: true, desc: 'Crispy dosa topped with grated mozzarella cheese & potato filling.' },
  { name: 'Idli Sambar (2 Pcs)', category: 'South Indian', price: 80, cost: 22, is_veg: true, desc: 'Steamed fluffy rice cakes served with hot vegetable lentil stew & coconut dip.' },
  { name: 'Medu Vada (2 Pcs)', category: 'South Indian', price: 90, cost: 26, is_veg: true, desc: 'Crispy golden fried lentil donuts served with chutney & sambar.' },
  { name: 'Onion Uttapam', category: 'South Indian', price: 130, cost: 38, is_veg: true, desc: 'Thick savory rice pancake topped with fresh chopped onions & green chillies.' },

  // Fast Food & Snacks
  { name: 'Veg Grilled Club Sandwich', category: 'Fast Food', price: 150, cost: 45, is_veg: true, desc: 'Triple decker sandwich loaded with cheese, veggies and mint mayo.' },
  { name: 'Paneer Crispy Burger', category: 'Fast Food', price: 130, cost: 42, is_veg: true, desc: 'Crunchy paneer patty with lettuce, tomato, cheese and signature dressing.' },
  { name: 'French Fries (Peri-Peri)', category: 'Fast Food', price: 120, cost: 35, is_veg: true, desc: 'Crispy potato fingers dusted with tangy spicy peri-peri seasoning.' },
  { name: 'Veg Hakka Noodles', category: 'Fast Food', price: 160, cost: 48, is_veg: true, desc: 'Stir-fried noodles with julienned vegetables and soya dressing.' },
  { name: 'Pav Bhaji (2 Pavs)', category: 'Fast Food', price: 140, cost: 42, is_veg: true, desc: 'Spicy mashed vegetable curry served with butter-toasted pav buns & lemon.' },
  { name: 'Chole Bhature (2 Bhature)', category: 'Fast Food', price: 160, cost: 48, is_veg: true, desc: 'Fluffy golden bhature served with spicy Punjabi chole & pickles.' },
  { name: 'White Sauce Pasta (Alfredo)', category: 'Fast Food', price: 220, cost: 70, is_veg: true, desc: 'Penne pasta in rich creamy cheese sauce with herbs & vegetables.' },

  // Desserts
  { name: 'Gulab Jamun (2 Pcs)', category: 'Desserts', price: 70, cost: 20, is_veg: true, desc: 'Hot golden fried milk dough dumplings soaked in rose cardamom sugar syrup.' },
  { name: 'Rasmalai (2 Pcs)', category: 'Desserts', price: 90, cost: 30, is_veg: true, desc: 'Soft spongy cottage cheese patties in chilled saffron pistachios milk.' },
  { name: 'Sizzling Brownie with Ice Cream', category: 'Desserts', price: 160, cost: 55, is_veg: true, desc: 'Warm chocolate walnut brownie with vanilla ice cream & hot chocolate fudge.' },
  { name: 'Gajar Ka Halwa (Desi Ghee)', category: 'Desserts', price: 110, cost: 35, is_veg: true, desc: 'Traditional winter delicacy made with fresh carrots, milk and dry fruits.' },

  // Beverages
  { name: 'Kulhad Masala Chai', category: 'Beverages', price: 30, cost: 8, is_veg: true, desc: 'Authentic slow-brewed Indian spiced tea served in traditional earthen cup.' },
  { name: 'Cold Coffee with Ice Cream', category: 'Beverages', price: 110, cost: 35, is_veg: true, desc: 'Thick creamy blended iced coffee topped with vanilla ice cream scoop.' },
  { name: 'Fresh Lime Soda', category: 'Beverages', price: 60, cost: 15, is_veg: true, desc: 'Refreshing freshly squeezed lime juice with bubbly soda (Sweet / Salted).' },
  { name: 'Mango Lassi', category: 'Beverages', price: 80, cost: 24, is_veg: true, desc: 'Thick creamy yogurt smoothie flavored with Alphonso mango pulp & cardamom.' },
  { name: 'Virgin Mojito', category: 'Beverages', price: 120, cost: 32, is_veg: true, desc: 'Muddled fresh mint leaves, lime wedges and sparkling soda with ice.' },
  { name: 'Mineral Water (1 Litre)', category: 'Beverages', price: 20, cost: 12, is_veg: true, desc: 'Packaged chilled drinking water bottle.' },

  // Thalis & Combos
  { name: 'Chef Special Royal Thali', category: 'Thalis', price: 280, cost: 95, is_veg: true, desc: 'Paneer Butter Masala, Dal Makhani, Mix Veg, Jeera Rice, 2 Butter Naan, Raita, Salad, Papad & Gulab Jamun.' },
  { name: 'Deluxe Veg Thali', category: 'Thalis', price: 210, cost: 70, is_veg: true, desc: 'Paneer dish, Yellow Dal Tadka, Seasonal Sabzi, Steamed Rice, 3 Butter Roti, Salad & Pickle.' },
  { name: 'Executive Non-Veg Thali', category: 'Thalis', price: 340, cost: 125, is_veg: false, desc: 'Butter Chicken, Dal Makhani, Chicken Biryani Rice, 2 Butter Naan, Raita, Salad & Gulab Jamun.' }
];

async function seed() {
  try {
    const { rows: partners } = await pool.query('SELECT id, restaurant_name FROM partners');
    console.log(`Found ${partners.length} partners.`);

    for (const partner of partners) {
      console.log(`Seeding 48 menu items for ${partner.restaurant_name} (${partner.id})...`);
      for (const item of MENU_ITEMS_CATALOG) {
        const id = 'menu-' + Math.random().toString(36).substring(2, 10);
        const foodCostPercent = Math.round(((item.cost / item.price) * 100) * 100) / 100;
        const margin = item.price - item.cost;
        
        await pool.query(
          `INSERT INTO menu_items (
            id, restaurant_id, name, category, description,
            selling_price, cost_price, food_cost, food_cost_percentage,
            food_cost_percent, gross_margin, is_vegetarian, is_available, status, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, 'active', NOW(), NOW()
          )`,
          [
            id, partner.id, item.name, item.category, item.desc,
            item.price, item.cost, item.cost, foodCostPercent,
            foodCostPercent, margin, item.is_veg
          ]
        );
      }
    }

    const { rows: count } = await pool.query('SELECT count(*) FROM menu_items');
    console.log(`✅ Successfully seeded! Total menu_items now in database: ${count[0].count}`);
  } catch (err) {
    console.error('Error seeding menu items:', err);
  } finally {
    await pool.end();
  }
}

seed();
